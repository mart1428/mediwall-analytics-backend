'use strict';

require('dotenv').config();

/**
 * Centralized, validated configuration. Fails fast if the connection string is
 * missing so the service never silently starts without a database.
 */
const config = {
  port: Number(process.env.PORT) || 8080,

  // Atlas connection string. NEVER hard-code this — provide via env / secret store.
  mongoUri: process.env.MONGODB_URI || '',

  // Dedicated analytics database on the cluster. Kept separate from the website
  // DB so analytics can never read or write app/website data.
  dbName: process.env.MONGODB_DB || 'mediwall_analytics',

  // Shared secret the app must send as `x-api-key`. If left empty, the auth
  // check is skipped (handy for first local testing) — set it before production.
  apiKey: process.env.ANALYTICS_API_KEY || '',

  // ── Built-in analytics dashboard (GET /dashboard) ──────────────────────────
  // Protected with HTTP Basic Auth, kept SEPARATE from the ingest `x-api-key` so
  // the app's secret never has to live in a browser. Mirrors the ingest-auth
  // philosophy: the gate is skipped while the password is empty (convenient for
  // local testing) and enforced once you set it. SET IT BEFORE PRODUCTION — the
  // dashboard exposes feedback messages and contact emails.
  dashboardUser: process.env.DASHBOARD_USER || 'admin',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // Max accepted JSON body. Payloads are tiny; this blunts abuse.
  bodyLimit: process.env.BODY_LIMIT || '16kb',
};

if (!config.mongoUri) {
  console.error('FATAL: MONGODB_URI is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

module.exports = config;
