'use strict';

/**
 * Read-side analytics. Turns the raw `metrics_daily` / `feedback` collections
 * into the numbers the built-in dashboard renders (KPIs, daily trends, feature
 * adoption, retention, platform/version splits, feedback). Read-only — never
 * writes. All aggregations are scoped to `mediwall_analytics`, so they can't see
 * the website DB.
 *
 * Data-model reminders (see README §8):
 *   - metrics_daily: one doc per (installId, date). `date` is a "YYYY-MM-DD"
 *     string, so lexicographic comparison == chronological comparison.
 *   - counts live under `events.*`; `sessions`/`crashes` are top-level rollups.
 *   - feedback.submittedAt is a real Date.
 */

// Feature events worth charting for "what gets used" — the lifecycle events
// (session_start/app_foreground/home_open/app_crash) are surfaced separately.
const FEATURE_EVENTS = [
  'medication_add',
  'appointment_add',
  'symptom_log',
  'mood_log',
  'todo_add',
  'backup_enabled',
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// UTC "YYYY-MM-DD" for a Date — matches how the client/smoke stamp `date`.
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * MS_PER_DAY);
const ymdToDate = (s) => new Date(`${s}T00:00:00.000Z`);

/**
 * Build the full dashboard payload for the trailing `days` window (inclusive of
 * today). Runs the aggregations concurrently and assembles one JSON response so
 * the frontend needs a single round trip.
 */
async function getSummary(db, days) {
  const span = Math.min(Math.max(parseInt(days, 10) || 30, 1), 365);
  const today = new Date();
  const to = ymd(today);
  const from = ymd(addDays(today, -(span - 1)));
  const metrics = db.collection('metrics_daily');
  const feedback = db.collection('feedback');

  const [
    dailyRaw,
    activeInstalls,
    newInstalls,
    featureRaw,
    platformsRaw,
    versionsRaw,
    retentionRaw,
    feedbackCountsRaw,
    feedbackRecent,
  ] = await Promise.all([
    dailySeries(metrics, from, to),
    metrics.distinct('installId', { date: { $gte: from, $lte: to } }),
    newInstallCount(metrics, from, to),
    featureTotals(metrics, from, to),
    splitByInstall(metrics, from, to, '$os'),
    splitByInstall(metrics, from, to, '$lastAppVersion'),
    retentionCohorts(metrics),
    feedbackCounts(feedback, today, span),
    recentFeedback(feedback, 50),
  ]);

  // Fill gaps so the trend charts have a continuous x-axis (zero on quiet days).
  const byDate = new Map(dailyRaw.map((d) => [d._id, d]));
  const daily = [];
  for (let i = 0; i < span; i++) {
    const date = ymd(addDays(ymdToDate(from), i));
    const row = byDate.get(date);
    daily.push({
      date,
      dau: row ? row.dau : 0,
      sessions: row ? row.sessions : 0,
      opens: row ? row.opens : 0,
      crashes: row ? row.crashes : 0,
    });
  }

  const totals = daily.reduce(
    (a, d) => {
      a.sessions += d.sessions;
      a.crashes += d.crashes;
      a.opens += d.opens;
      return a;
    },
    { sessions: 0, crashes: 0, opens: 0 },
  );
  const dauToday = byDate.get(to) ? byDate.get(to).dau : 0;
  const crashFreeRate =
    totals.sessions > 0 ? 1 - totals.crashes / totals.sessions : 1;

  const features = FEATURE_EVENTS.map((name) => ({
    name,
    count: featureRaw[name] || 0,
  })).sort((a, b) => b.count - a.count);

  // Retention KPIs: average across cohorts old enough to have had the chance.
  const d1Eligible = retentionRaw.filter((c) => c.cohort < to);
  const d7Eligible = retentionRaw.filter((c) => c.cohort <= ymd(addDays(today, -7)));
  const weightedRate = (rows, key) => {
    const installs = rows.reduce((s, c) => s + c.installs, 0);
    if (!installs) return null;
    return rows.reduce((s, c) => s + c[key], 0) / installs;
  };

  return {
    generatedAt: new Date().toISOString(),
    range: { from, to, days: span },
    kpis: {
      activeInstalls: activeInstalls.length,
      dauToday,
      newInstalls,
      totalSessions: totals.sessions,
      totalCrashes: totals.crashes,
      crashFreeRate,
      d1Retention: weightedRate(d1Eligible, 'd1'),
      d7Retention: weightedRate(d7Eligible, 'd7'),
    },
    daily,
    features,
    platforms: platformsRaw.map((p) => ({
      label: p._id || 'unknown',
      installs: p.installs,
    })),
    versions: versionsRaw
      .map((v) => ({ label: v._id || 'unknown', installs: v.installs }))
      .slice(0, 8),
    retention: retentionRaw.slice(-30), // last 30 cohorts for the trend line
    feedback: {
      total: feedbackCountsRaw.reduce((s, c) => s + c.n, 0),
      byCategory: {
        bug: catCount(feedbackCountsRaw, 'bug'),
        idea: catCount(feedbackCountsRaw, 'idea'),
        other: catCount(feedbackCountsRaw, 'other'),
      },
      recent: feedbackRecent,
    },
  };
}

// ── Aggregation building blocks ───────────────────────────────────────────────

// Per-day actives + engagement/stability rollups within [from, to].
function dailySeries(metrics, from, to) {
  return metrics
    .aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$date',
          dau: { $sum: 1 }, // one doc per install/day ⇒ doc count == distinct installs
          sessions: { $sum: { $ifNull: ['$sessions', 0] } },
          opens: { $sum: { $ifNull: ['$events.home_open', 0] } },
          crashes: { $sum: { $ifNull: ['$crashes', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
}

// New installs = installs whose first-ever active date lands inside [from, to].
// Derived from min(date) per install so it's correct regardless of the per-doc
// `firstSeenAt` quirk (that field is stamped per (install,date), not per install).
async function newInstallCount(metrics, from, to) {
  const res = await metrics
    .aggregate([
      { $group: { _id: '$installId', firstDate: { $min: '$date' } } },
      { $match: { firstDate: { $gte: from, $lte: to } } },
      { $count: 'n' },
    ])
    .toArray();
  return res.length ? res[0].n : 0;
}

// SUM of each feature event across the window.
async function featureTotals(metrics, from, to) {
  const sums = {};
  for (const e of FEATURE_EVENTS) sums[e] = { $sum: { $ifNull: [`$events.${e}`, 0] } };
  const res = await metrics
    .aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      { $group: { _id: null, ...sums } },
    ])
    .toArray();
  return res.length ? res[0] : {};
}

// Distinct installs in the window, split by a per-install field (os / version),
// taking each install's most recently reported value.
function splitByInstall(metrics, from, to, field) {
  return metrics
    .aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      { $sort: { date: -1 } },
      { $group: { _id: '$installId', value: { $first: field } } },
      { $group: { _id: '$value', installs: { $sum: 1 } } },
      { $sort: { installs: -1 } },
    ])
    .toArray();
}

// Per-cohort Day-1 / Day-7 retention. cohort = an install's first active date;
// d1/d7 = how many of that cohort were active again on cohort+1 / cohort+7.
function retentionCohorts(metrics) {
  return metrics
    .aggregate([
      { $group: { _id: '$installId', cohort: { $min: '$date' }, days: { $addToSet: '$date' } } },
      {
        $project: {
          cohort: 1,
          retD1: {
            $in: [
              {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: {
                    $dateAdd: {
                      startDate: { $dateFromString: { dateString: '$cohort' } },
                      unit: 'day',
                      amount: 1,
                    },
                  },
                },
              },
              '$days',
            ],
          },
          retD7: {
            $in: [
              {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: {
                    $dateAdd: {
                      startDate: { $dateFromString: { dateString: '$cohort' } },
                      unit: 'day',
                      amount: 7,
                    },
                  },
                },
              },
              '$days',
            ],
          },
        },
      },
      {
        $group: {
          _id: '$cohort',
          installs: { $sum: 1 },
          d1: { $sum: { $cond: ['$retD1', 1, 0] } },
          d7: { $sum: { $cond: ['$retD7', 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          cohort: '$_id',
          installs: 1,
          d1: 1,
          d7: 1,
          d1Rate: { $cond: [{ $gt: ['$installs', 0] }, { $divide: ['$d1', '$installs'] }, 0] },
          d7Rate: { $cond: [{ $gt: ['$installs', 0] }, { $divide: ['$d7', '$installs'] }, 0] },
        },
      },
    ])
    .toArray();
}

// Feedback volume by category within the same trailing window.
function feedbackCounts(feedback, today, span) {
  const from = addDays(new Date(`${ymd(today)}T00:00:00.000Z`), -(span - 1));
  const to = addDays(new Date(`${ymd(today)}T00:00:00.000Z`), 1); // end of today
  return feedback
    .aggregate([
      { $match: { submittedAt: { $gte: from, $lt: to } } },
      { $group: { _id: '$category', n: { $sum: 1 } } },
    ])
    .toArray();
}

// Newest feedback for the triage table. PHI-free, but contains contact emails —
// which is exactly why the dashboard sits behind its own auth gate.
async function recentFeedback(feedback, limit) {
  const rows = await feedback
    .find({}, {
      projection: { category: 1, message: 1, contactEmail: 1, appVersion: 1, os: 1, submittedAt: 1 },
    })
    .sort({ submittedAt: -1 })
    .limit(limit)
    .toArray();
  return rows.map((r) => ({
    category: r.category,
    message: r.message,
    contactEmail: r.contactEmail || null,
    appVersion: r.appVersion || null,
    os: r.os || null,
    submittedAt: r.submittedAt ? new Date(r.submittedAt).toISOString() : null,
  }));
}

const catCount = (rows, cat) => {
  const hit = rows.find((r) => r._id === cat);
  return hit ? hit.n : 0;
};

module.exports = { getSummary, FEATURE_EVENTS };
