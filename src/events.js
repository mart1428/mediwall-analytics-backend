'use strict';

/**
 * The closed allowlist of event names — MUST stay in sync with the app's
 * components/analytics/events.ts. Anything outside this set is dropped on
 * ingest, so a buggy or malicious client can never store arbitrary keys.
 */
const ALLOWED_EVENTS = new Set([
  'session_start',
  'app_foreground',
  'home_open',
  'medication_add',
  'appointment_add',
  'symptom_log',
  'mood_log',
  'todo_add',
  'backup_enabled',
  'app_crash',
]);

const FEEDBACK_CATEGORIES = new Set(['bug', 'idea', 'other']);

module.exports = { ALLOWED_EVENTS, FEEDBACK_CATEGORIES };
