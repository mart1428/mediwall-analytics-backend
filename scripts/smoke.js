'use strict';

/**
 * Tiny end-to-end smoke test: POSTs a sample metrics payload and a feedback
 * payload to a running server, then prints the responses. Use it after `npm run
 * dev` to confirm the endpoints + Mongo writes work.
 *
 *   BASE=http://localhost:8080 API_KEY=yourkey node scripts/smoke.js
 */

const BASE = process.env.BASE || 'http://localhost:8080';
const API_KEY = process.env.API_KEY || '';

const headers = {
  'Content-Type': 'application/json',
  ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
};

const today = new Date().toISOString().slice(0, 10);

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  console.log(`${path} → ${res.status}`);
  return res.status;
}

(async () => {
  await post('/v1/metrics', {
    installId: 'smoke-test-install-0001',
    date: today,
    appVersion: '1.0.0',
    os: 'ios',
    sessions: 1,
    crashes: 0,
    events: { session_start: 1, home_open: 3, medication_add: 1 },
  });

  await post('/v1/feedback', {
    category: 'idea',
    message: 'Smoke test feedback — please ignore.',
    contactEmail: null,
    appVersion: '1.0.0',
    os: 'ios',
    submittedAt: new Date().toISOString(),
  });

  const health = await fetch(`${BASE}/health`).then((r) => r.status);
  console.log(`/health → ${health}`);
  console.log('Done. Check Atlas → mediwall_analytics → metrics_daily / feedback.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
