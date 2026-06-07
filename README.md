# MediWall Analytics Backend

A tiny, standalone Express + MongoDB service that ingests **anonymous, aggregate**
usage metrics and user feedback from the MediWall app. It stores **no PHI** — only
counts of allowlisted event names, tied to a random per-install id.

- Client contract & privacy model: see [../MediWall-app-master/ANALYTICS_BACKEND.md](../MediWall-app-master/ANALYTICS_BACKEND.md)
- Endpoints: `POST /v1/metrics`, `POST /v1/feedback`, `GET /health`

---

## 1. Can I reuse the existing Atlas cluster? — Yes

Your website already uses an Atlas cluster (`mediwall-001…`). A single cluster hosts
**many databases**, and MongoDB creates databases/collections **lazily on first write**.
So this service connects to the **same cluster** but a **separate database**
(`mediwall_analytics`), keeping analytics fully isolated from the website's data.

You do **not** pre-create anything by hand — the service creates the
`metrics_daily` and `feedback` collections and their indexes automatically on first run.

---

## 2. Getting your `MONGODB_URI` (and a safer, scoped user)

You *could* paste the website's existing `MONGODB_URI`, but the better practice is a
**dedicated database user** that can only touch `mediwall_analytics` (least privilege).

### Option A — dedicated analytics user (recommended)
1. Go to **MongoDB Atlas** → your project → **Database Access** → **Add New Database User**.
2. Auth method **Password**. Username e.g. `analytics_svc`; generate a strong password.
3. Under **Database User Privileges** → **Specific Privileges** → add
   role **`readWrite`** on database **`mediwall_analytics`**. (No access to anything else.)
4. **Network Access** → ensure your server's egress IP is allowlisted (or `0.0.0.0/0`
   only if the service is otherwise protected; prefer a fixed IP).
5. **Clusters** → **Connect** → **Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://analytics_svc:<password>@mediwall-001.2fbsb3c.mongodb.net/?retryWrites=true&w=majority&appName=MediWall-001
   ```
   Replace `<password>`. Leave the path empty (no `/dbname`) — this app selects the DB via
   `MONGODB_DB`.

### Option B — reuse the website user (fastest, less safe)
Copy the `MONGODB_URI` from `MediWall-Website/.env` as-is. It already has access to the
cluster, so it will work. Downside: that user can read/write the website DB too, so a leak
of this service's env is broader. If you do this, plan to rotate to Option A before launch.

> 🔐 Security notes:
> - The value in `MediWall-Website/.env` is a live credential. Make sure that `.env` is
>   gitignored, and consider **rotating that password** since it's been shared around.
> - Never commit this service's `.env`. Use your host's secret manager in production.

---

## 3. Run locally

```bash
cd MediWall-analytics-backend
cp .env.example .env          # then edit .env with your real values
npm install
npm run dev                   # starts on :8080 with --watch

# in another terminal, exercise the endpoints + verify Mongo writes:
npm run smoke                 # or: BASE=http://localhost:8080 API_KEY=... node scripts/smoke.js
```

Then check Atlas → database `mediwall_analytics` → collections `metrics_daily` and
`feedback` for the smoke-test documents.

---

## 4. Environment variables

| Var                 | Required | Purpose                                                        |
| ------------------- | -------- | -------------------------------------------------------------- |
| `MONGODB_URI`       | yes      | Atlas connection string (no `/dbname` in the path).           |
| `MONGODB_DB`        | no       | Analytics DB name. Default `mediwall_analytics`.              |
| `ANALYTICS_API_KEY` | no\*     | Shared secret the app sends as `x-api-key`. \*Set before prod. |
| `PORT`              | no       | Listen port. Default `8080`.                                  |

The auth check is **skipped while `ANALYTICS_API_KEY` is empty** (convenient for first
tests) and **enforced once you set it**.

---

## 5. Deploy to Render (recommended — uses the included `render.yaml`)

A Render **Blueprint** ([render.yaml](render.yaml)) is included, so the service is created
for you with the right runtime, health check, and env-var slots. Render provides the HTTPS
URL iOS requires.

### Step-by-step
1. **Push this repo to GitHub/GitLab** (Render deploys from a Git remote):
   ```bash
   git remote add origin https://github.com/<you>/mediwall-analytics-backend.git
   git push -u origin main
   ```
2. **Atlas Network Access** — Render's free plan has **no static outbound IP**, so the DB
   must accept connections from anywhere: Atlas → **Network Access** → **Add IP Address** →
   **Allow Access from Anywhere** (`0.0.0.0/0`). The DB user's password is still required,
   so access stays credential-gated. *(For a fixed IP later, use a paid Render plan or a
   static-egress add-on, then narrow this.)*
3. **Render → New → Blueprint** → connect the repo. Render reads `render.yaml` and shows the
   service `mediwall-analytics`.
4. **Paste the two secrets** when prompted (they are `sync:false`, never in git):
   - `MONGODB_URI` — your Atlas connection string.
   - `ANALYTICS_API_KEY` — the same value as the app's `expo.extra.analytics.apiKey`.
5. **Apply / Create**. First build takes a few minutes. When live, Render gives a URL like
   `https://mediwall-analytics.onrender.com`.
6. **Verify:** open `https://YOUR-URL/health` → `{ "ok": true }`.

> Free-plan behavior: the service **sleeps after ~15 min idle** and cold-starts (~30–60s) on
> the next request. That's fine here — the app's flush is fire-and-forget and retries on the
> next launch/foreground if a cold start times out. Upgrade to a paid instance if you want
> always-on / no cold starts.

### Alternative: any Node host
```bash
npm install --omit=dev
NODE_ENV=production node src/server.js   # put behind a TLS reverse proxy — iOS requires HTTPS
```

---

## 6. Point the app at it

In `MediWall-app-master/app.json` → `expo.extra.analytics`:
```jsonc
"analytics": {
  "enabled": true,
  "backendUrl": "https://YOUR_HOST"   // no trailing slash needed
}
```
If you set `ANALYTICS_API_KEY`, tell the app developer the key so the `x-api-key` header
can be wired into the two client POST helpers, then rebuild the app (`eas build`).

---

## 7. Reading the data (DAU / MAU / retention)

```js
// DAU — distinct installs that reported a given day:
db.metrics_daily.countDocuments({ date: '2026-06-07' })

// MAU — distinct installs over a trailing 30 days:
db.metrics_daily.distinct('installId',
  { date: { $gte: '2026-05-08', $lte: '2026-06-07' } }).length

// Feature adoption for a day:
db.metrics_daily.aggregate([
  { $match: { date: '2026-06-07' } },
  { $group: { _id: null,
      meds:  { $sum: '$events.medication_add' },
      appts: { $sum: '$events.appointment_add' },
      moods: { $sum: '$events.mood_log' },
      opens: { $sum: '$events.home_open' },
      crashes: { $sum: '$crashes' } } },
])

// Day-1 retention for installs first seen on a date:
// (firstSeenAt is stamped on each install's first metrics doc.)
db.metrics_daily.aggregate([
  { $match: { firstSeenAt: { $gte: ISODate('2026-06-07'), $lt: ISODate('2026-06-08') } } },
  { $group: { _id: '$installId' } },           // the cohort
  // ...then check which of those installId have a doc with date = cohortDay + 1.
])
```

For dashboards, point **MongoDB Charts** (built into Atlas) or **Metabase** at the
`mediwall_analytics` DB — no extra code needed. A ready-made chart-by-chart dashboard
(DAU, MAU, retention, feature adoption, crashes, platform/version split, feedback) is in
[CHARTS.md](CHARTS.md).

---

## 8. Data model

`metrics_daily` (one per install per day; counts accumulate via `$inc`):
```jsonc
{
  "installId": "9f1c…",
  "date": "2026-06-07",
  "events": { "home_open": 12, "medication_add": 2, "session_start": 3 },
  "sessions": 3,
  "crashes": 0,
  "os": "ios",
  "lastAppVersion": "1.0.0",
  "firstSeenAt": ISODate("2026-06-07T…"),
  "updatedAt": ISODate("2026-06-07T…")
}
```

`feedback` (one per submission):
```jsonc
{
  "category": "bug",
  "message": "…",
  "contactEmail": null,
  "appVersion": "1.0.0",
  "os": "ios",
  "submittedAt": ISODate("…"),
  "receivedAt": ISODate("…")
}
```
