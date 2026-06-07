'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { getDb } = require('./db');
const { ALLOWED_EVENTS, FEEDBACK_CATEGORIES } = require('./events');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: config.bodyLimit }));

// Basic abuse protection. Payloads are tiny and infrequent, so this is generous
// for real users but stops floods.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ── Health check (no auth) — for platform probes / uptime checks ──────────────
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── Shared-secret auth ────────────────────────────────────────────────────────
// Enforced only when ANALYTICS_API_KEY is configured, so you can test locally
// without a key, then lock it down for production by setting the env var.
app.use((req, res, next) => {
  if (!config.apiKey) return next();
  const provided = req.get('x-api-key') || '';
  if (provided !== config.apiKey) return res.sendStatus(401);
  next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isOs = (s) => s === 'ios' || s === 'android';
const isNonEmptyString = (s, max) =>
  typeof s === 'string' && s.length > 0 && s.length <= max;

// ── POST /v1/metrics ──────────────────────────────────────────────────────────
// Body: { installId, date, appVersion, os, sessions, crashes, events:{name:count} }
// IMPORTANT: counts are DELTAS — accumulate with $inc, never overwrite.
app.post('/v1/metrics', async (req, res) => {
  try {
    const { installId, date, appVersion, os, events } = req.body || {};

    if (!isNonEmptyString(installId, 100) || !isYmd(date) || !isOs(os)) {
      return res.sendStatus(400);
    }

    // Build a $inc of ONLY allowlisted, positive-integer event counts.
    const inc = {};
    if (events && typeof events === 'object') {
      for (const [name, count] of Object.entries(events)) {
        if (ALLOWED_EVENTS.has(name) && Number.isInteger(count) && count > 0) {
          inc[`events.${name}`] = count;
        }
      }
    }
    // Convenience top-level rollups derived from the same allowlisted counts.
    if (inc['events.session_start']) inc.sessions = inc['events.session_start'];
    if (inc['events.app_crash']) inc.crashes = inc['events.app_crash'];

    const update = {
      $setOnInsert: { installId, date, firstSeenAt: new Date() },
      $set: {
        os,
        lastAppVersion: isNonEmptyString(appVersion, 40) ? appVersion : null,
        updatedAt: new Date(),
      },
    };
    // $inc must not be empty; only attach it when there's something to add.
    if (Object.keys(inc).length > 0) update.$inc = inc;

    const db = await getDb();
    await db.collection('metrics_daily').updateOne({ installId, date }, update, {
      upsert: true,
    });

    return res.sendStatus(204);
  } catch (e) {
    console.error(`/v1/metrics error: ${e}`);
    return res.sendStatus(500);
  }
});

// ── POST /v1/feedback ─────────────────────────────────────────────────────────
// Body: { category, message, contactEmail?, appVersion, os, submittedAt }
app.post('/v1/feedback', async (req, res) => {
  try {
    const { category, message, contactEmail, appVersion, os, submittedAt } =
      req.body || {};

    if (!FEEDBACK_CATEGORIES.has(category)) return res.sendStatus(400);
    if (!isNonEmptyString(message, 1000)) return res.sendStatus(400);

    const doc = {
      category,
      message,
      contactEmail:
        typeof contactEmail === 'string' && contactEmail.length > 0 && contactEmail.length <= 200
          ? contactEmail
          : null,
      appVersion: isNonEmptyString(appVersion, 40) ? appVersion : null,
      os: isOs(os) ? os : null,
      submittedAt: typeof submittedAt === 'string' ? new Date(submittedAt) : new Date(),
      receivedAt: new Date(),
    };

    const db = await getDb();
    await db.collection('feedback').insertOne(doc);

    return res.sendStatus(204);
  } catch (e) {
    console.error(`/v1/feedback error: ${e}`);
    return res.sendStatus(500);
  }
});

// Warm the DB connection at boot so the first request isn't slow / failing.
getDb().catch((e) => {
  console.error(`Mongo connect failed at boot: ${e}`);
  process.exit(1);
});

app.listen(config.port, () => {
  console.log(`MediWall analytics backend listening on :${config.port}`);
});
