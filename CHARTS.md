# MongoDB Charts — dashboards for MediWall analytics

MongoDB Charts is built into Atlas (left nav → **Charts**) and reads the
`mediwall_analytics` database directly — no extra code. Below is a recommended
dashboard, chart-by-chart: the **data source**, **chart type**, **encodings**, and (where
needed) a **query/pipeline** you paste into the chart's *Query* box.

> Setup once:
> 1. Atlas → **Charts** → **Add Data Source** → pick the cluster → select database
>    `mediwall_analytics` → add collections `metrics_daily` and `feedback`.
> 2. Create a dashboard "MediWall — Product Analytics".
> 3. Add the charts below. The *Query* box on each chart takes a normal find-filter
>    (`{ ... }`); for the cohort/MAU ones use a **Charts aggregation** data source
>    (described inline).

Reminder on the data model: `metrics_daily` has **one document per `installId` per `date`**,
with per-event counts under `events.*`, plus top-level `sessions` and `crashes`, and a
`firstSeenAt` timestamp stamped on the install's first-ever document.

---

## 1. DAU — Daily Active Users

- **Source:** `metrics_daily`
- **Type:** Line (or Column)
- **Encodings:**
  - X axis: `date` (Category, sort ascending)
  - Y axis: **Count** of documents (aggregate = COUNT) — because there's exactly one doc
    per install per day, the document count *is* the distinct-install count.
- **Query (optional, last ~30 days):**
  ```json
  { "date": { "$gte": "2026-05-08" } }
  ```

## 2. MAU — 30-day Monthly Active Users (rolling)

DAU's COUNT trick doesn't work for MAU because one install appears on many days. Use a
**Charts aggregation pipeline** data source instead (Charts → Add Data Source → the
collection → "..." → **Aggregation Pipeline**), named e.g. `mau_rolling`:

```js
[
  // distinct installs per trailing-30-day window, bucketed by end day
  { $group: { _id: "$installId", days: { $addToSet: "$date" } } },
  { $unwind: "$days" },
  { $group: { _id: "$days", installs: { $addToSet: "$_id" } } },
  { $project: { date: "$_id", mau: { $size: "$installs" }, _id: 0 } },
  { $sort: { date: 1 } },
]
```
- **Type:** Line · X: `date` · Y: `mau` (no further aggregation).

> For a true rolling 30-day MAU you'd window each day over the prior 30; the above gives
> "distinct installs seen on each day." For most early dashboards a **KPI: distinct
> `installId` where `date` ≥ today−30** is enough — see chart 3.

## 3. KPI — Active installs (last 30 days)

- **Source:** `metrics_daily`
- **Type:** Number (KPI)
- **Encodings:** Aggregate **Distinct count** of `installId`.
- **Query:**
  ```json
  { "date": { "$gte": "2026-05-08" } }
  ```
  (Use a relative date in Charts' date filter so it auto-rolls.)

## 4. Feature adoption (stacked) — what gets used

- **Source:** `metrics_daily`
- **Type:** Stacked column
- **Encodings:**
  - X axis: `date`
  - Y axis (add several **SUM** series): `events.medication_add`, `events.appointment_add`,
    `events.symptom_log`, `events.mood_log`, `events.todo_add`, `events.backup_enabled`
- Shows which features drive engagement over time.

## 5. App opens & sessions

- **Source:** `metrics_daily`
- **Type:** Line (two series)
- **Encodings:** X: `date` · Y: SUM of `events.home_open`, and SUM of `sessions`.

## 6. Stability — crashes per day & crash rate

- **Source:** `metrics_daily`
- **Type:** Column
- **Encodings:** X: `date` · Y: SUM of `crashes`.
- **Crash rate (optional)** via aggregation source `crash_rate`:
  ```js
  [
    { $group: { _id: "$date",
        crashes: { $sum: "$crashes" },
        sessions: { $sum: "$sessions" } } },
    { $project: { date: "$_id", _id: 0,
        crashesPerSession: {
          $cond: [{ $gt: ["$sessions", 0] },
                  { $divide: ["$crashes", "$sessions"] }, 0] } } },
    { $sort: { date: 1 } },
  ]
  ```

## 7. Platform split (iOS vs Android)

- **Source:** `metrics_daily`
- **Type:** Donut
- **Encodings:** Label: `os` · Value: **Distinct count** of `installId`.

## 8. App version distribution

- **Source:** `metrics_daily`
- **Type:** Bar
- **Encodings:** X: `lastAppVersion` · Y: Distinct count of `installId`.
- Useful to see how fast users move to new builds.

## 9. Day-1 / Day-7 retention (cohorts)

Use an aggregation-pipeline source `retention` (this self-joins installs to their own
later activity):

```js
[
  // 1) first-seen day per install
  { $group: { _id: "$installId",
      cohort: { $min: "$date" },
      days:   { $addToSet: "$date" } } },
  // 2) was the install active on cohort+1 and cohort+7?
  { $project: {
      cohort: 1,
      d1: { $in: [
        { $dateToString: { format: "%Y-%m-%d",
          date: { $dateAdd: { startDate: { $dateFromString: { dateString: "$cohort" } },
                              unit: "day", amount: 1 } } } },
        "$days" ] },
      d7: { $in: [
        { $dateToString: { format: "%Y-%m-%d",
          date: { $dateAdd: { startDate: { $dateFromString: { dateString: "$cohort" } },
                              unit: "day", amount: 7 } } } },
        "$days" ] } } },
  // 3) per-cohort retention rates
  { $group: { _id: "$cohort",
      installs: { $sum: 1 },
      d1: { $sum: { $cond: ["$d1", 1, 0] } },
      d7: { $sum: { $cond: ["$d7", 1, 0] } } } },
  { $project: { cohort: "$_id", _id: 0, installs: 1,
      d1Rate: { $divide: ["$d1", "$installs"] },
      d7Rate: { $divide: ["$d7", "$installs"] } } },
  { $sort: { cohort: 1 } },
]
```
- **Type:** Line · X: `cohort` · Y: `d1Rate`, `d7Rate` (format as %).

## 10. Feedback volume & breakdown

- **Source:** `feedback`
- **Type:** Column (by day) + Donut (by category)
- **Encodings:**
  - Column: X `submittedAt` (binned by day) · Y Count.
  - Donut: Label `category` (`bug`/`idea`/`other`) · Value Count.
- Add a **Table** chart on `feedback` (columns: `submittedAt`, `category`, `message`,
  `contactEmail`, `appVersion`, `os`) to triage incoming reports.

---

### Tips
- Set each time chart's **date filter** to a relative range (e.g. "last 90 days") so the
  dashboard rolls automatically.
- Charts caches; set a refresh interval (e.g. hourly) per dashboard.
- These pipelines read only `mediwall_analytics` — they can't see the website DB.
