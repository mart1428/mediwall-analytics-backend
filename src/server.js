'use strict';

const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const { getDb } = require('./db');
const { ALLOWED_EVENTS, FEEDBACK_CATEGORIES } = require('./events');
const { getSummary } = require('./stats');
const { dashboardHtml } = require('./dashboard');

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

// ── Epic OAuth redirect bounce (no auth — Epic's browser redirect lands here) ──
// iOS Safari often refuses to follow Epic's final HTTP 302 to the custom scheme
// `mediwall://callback` (user activation is lost across the multi-hop
// Authorize → LogOut → Redirect chain), which strands the login on a logged-out
// MyChart page. Epic also requires an https redirect URI before an app can be
// marked ready for production. This page receives the ?code=&state= query and
// hands it to the app via the custom scheme — automatically when Safari allows
// it, otherwise via the button tap (a real user gesture, which Safari honors).
// The auth code is single-use, expires within minutes, and is useless without
// the PKCE code_verifier stored on the device, so serving this page without
// auth is safe; nothing is logged or stored here.
app.get('/epic/callback', (_req, res) => {
  // Self-contained page: inline script/style only, no network access.
  // Overrides helmet's global CSP (which blocks inline script).
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  );
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Returning to MediWall</title>
<style>
  body { margin:0; font-family:-apple-system, system-ui, sans-serif; background:#F9FBF9; color:#1C3D2A;
         display:flex; min-height:100vh; align-items:center; justify-content:center; text-align:center; }
  main { padding:32px; max-width:420px; }
  h1 { font-size:22px; margin:0 0 8px; }
  p  { font-size:16px; line-height:1.5; color:#3A5A48; }
  a.btn { display:inline-block; margin-top:20px; padding:14px 28px; border-radius:12px;
          background:#4CAF50; color:#fff; font-size:17px; font-weight:600; text-decoration:none; }
  small { display:block; margin-top:24px; color:#6B8577; font-size:13px; }
</style>
</head>
<body>
<main>
  <h1>Returning you to MediWall&hellip;</h1>
  <p>If the app doesn't open automatically, tap the button below.</p>
  <a class="btn" id="open" href="#">Open MediWall</a>
  <small>You can close this tab once MediWall opens.</small>
</main>
<script>
  (function () {
    var target = 'mediwall://callback' + (location.search || '');
    document.getElementById('open').setAttribute('href', target);
    // Auto-attempt the handoff; if Safari blocks it (no user activation
    // surviving the redirect chain), the button tap always works.
    location.replace(target);
  })();
</script>
</body>
</html>`);
});

// ── Built-in dashboard (Basic-Auth gated, SEPARATE from the ingest x-api-key) ──
// Registered BEFORE the x-api-key middleware so these routes use their own gate
// and the app's ingest secret never has to be entered into a browser.
const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual requires equal length; the length check itself is not secret.
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

function dashboardAuth(req, res, next) {
  // Mirror the ingest-auth philosophy: open while the password is unset (local
  // testing), enforced once DASHBOARD_PASSWORD is configured.
  if (!config.dashboardPassword) return next();
  const [scheme, encoded] = (req.get('authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    if (safeEqual(user, config.dashboardUser) && safeEqual(pass, config.dashboardPassword)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="MediWall Analytics", charset="UTF-8"');
  return res.sendStatus(401);
}

app.get('/', (_req, res) => res.redirect('/dashboard'));
app.use(['/dashboard', '/v1/stats'], dashboardAuth);

app.get('/dashboard', (_req, res) => {
  // Tighten CSP just for this page: inline script/style for the self-contained
  // dashboard, same-origin fetch only, no external origins. Overrides helmet's
  // global default-src 'self' (which would block the inline code).
  res.set(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  );
  res.type('html').send(dashboardHtml());
});

app.get('/v1/stats/summary', async (req, res) => {
  try {
    const db = await getDb();
    const summary = await getSummary(db, req.query.days);
    // Dashboard reads should always reflect fresh data, never a proxy cache.
    res.set('Cache-Control', 'no-store');
    return res.json(summary);
  } catch (e) {
    console.error(`/v1/stats/summary error: ${e}`);
    return res.sendStatus(500);
  }
});

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
