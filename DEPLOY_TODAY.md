# Deploy Today — exact runbook

Goal: dashboard live on Vercel with durable Supabase storage, refreshing every
10 minutes, safe to share with leadership. Total time: ~20 minutes.

## 1. Create the Supabase project (~5 min)

1. [supabase.com](https://supabase.com) → **New project** (any name, e.g. `wachter-dashboard`).
2. Choose a strong database password (Supabase generates one — save it).
3. When the project finishes provisioning: **Connect** (top bar) → **Connection string → Transaction pooler**.
4. Copy the URI and substitute your password. It looks like:
   ```
   postgresql://postgres.abcdefghij:<PASSWORD>@aws-0-us-east-1.pooler.supabase.com:6543/postgres
   ```
   Use the **pooled (port 6543)** string — required for serverless.

## 2. Create the database tables (~2 min)

From this project directory on your machine:

```bash
DATABASE_URL="<paste the pooled connection string>" npx prisma db push
```

`db push` creates all tables from `prisma/schema.prisma`. It's the safest
option for a fresh database (no migration history needed). Re-running it later
is also safe — it only applies schema diffs.

> Alternative: never run schema changes *from* Vercel. Always push schema from
> your machine (or CI) so deploys stay read-only and reversible.

## 3. Create the Vercel project (~3 min)

1. Push this repo to GitHub (private repo is fine):
   ```bash
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```
2. [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Framework preset: **Next.js** (auto-detected). Leave build settings alone —
   `postinstall` runs `prisma generate` automatically.

## 4. Add environment variables (~5 min)

In the import screen (or later: Project → Settings → Environment Variables),
add every variable from `.env.production.example`:

| Variable | Value |
|---|---|
| `DATABASE_URL` | pooled Supabase string from step 1 |
| `APIFY_TOKEN` | your Apify token (consider rotating it first — it was shared in a chat) |
| `APIFY_TIKTOK_ACTOR_ID` | `GdWCkxBtKWOsKjdch` |
| `APIFY_INSTAGRAM_ACTOR_ID` | `xMc5Ga1oCONPmWJIa` |
| `APIFY_FACEBOOK_ACTOR_ID` | `KoJrdxJCTtpon81KY` |
| `APIFY_YOUTUBE_ACTOR_ID` | `WT1BVWatl2aHVeFEH` |
| `CRON_SECRET` | `openssl rand -hex 24` output |
| `ADMIN_PASSWORD` | a strong password — **required before sharing** |
| `NEXT_PUBLIC_APP_NAME` | `Wachter Creator Campaign Dashboard` |
| `YOUTUBE_API_KEY` | optional — leave empty for now |

## 5. Deploy

Click **Deploy**. The build runs `prisma generate` + `next build` (~2 min).

## 6. First refresh (~3 min)

Open `https://<your-app>.vercel.app/admin`, sign in with `ADMIN_PASSWORD`,
check the **Production readiness** card (everything should be green), then hit
**Refresh now**. The first refresh runs 4 Apify actors and takes 2–4 minutes.

Or trigger it from a terminal:

```bash
curl -X POST "https://<your-app>.vercel.app/api/cron/refresh" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

## 7. Verify

- `/` shows KPIs, the trend chart, platform cards with **Live** status
- `/admin` → Production readiness: Database ✓, Token ✓, Actors 4/4 ✓, Last refresh ✓, Cron ✓, Admin password ✓
- Thumbnails render (they're proxied through `/api/thumb`)

## 8. Scheduled refreshes

`vercel.json` ships a `*/10 * * * *` cron hitting `/api/cron/refresh`.

- **Vercel Pro**: works out of the box (10-min crons + long function duration).
- **Hobby plan**: crons are limited to daily and functions cap at ~60s, which a
  multi-actor refresh exceeds. Use a free external scheduler instead —
  [cron-job.org](https://cron-job.org): create a job every 5 minutes,
  URL `https://<your-app>.vercel.app/api/cron/refresh`, request header
  `Authorization: Bearer <CRON_SECRET>`, timeout 300s.
- **Current production setup (cost-controlled)**: cron-job.org job 7793727
  ("Wachter Campaign Dashboard Refresh") pings every 30 minutes during
  active hours only (06:00–23:59 America/New_York). The app's refresh
  policy (`src/lib/refresh-policy.ts`) decides what actually runs: full
  refresh every 60 min, discovery every 180 min, comments every 120 min,
  quiet hours 00:00–06:00 ET, and a daily Apify budget hard cap. The
  5-minute cadence burned ~$20/day; the policy targets $1–2/day. GitHub
  Actions remains a 30-minute best-effort backup (the same policy governs
  it). The endpoint answers 202 instantly and refreshes in the background.

## 9. Share with your boss

Send the URL. The dashboard reads in 30 seconds: header shows sources
connected + last refresh; "Data sources" expands to show exactly what each
platform delivers; every number shows freshness; anything a platform doesn't
expose says "Unavailable" — by design, never a fake zero.

---

### Notes

- **Apify cost**: every refresh runs 4 actors. At 10-minute intervals that's
  ~576 runs/day (~$20–60/month depending on actor pricing). Widen the schedule
  (e.g. `*/30`) in `vercel.json` or cron-job.org if credits matter.
- **Without DATABASE_URL** the app still deploys and works, but storage is
  ephemeral (/tmp) — history resets between invocations and the UI shows an
  amber "Ephemeral storage" banner. Don't share broadly in that state.
- **Schema changes later**: run `npx prisma db push` from your machine with the
  production `DATABASE_URL`, then deploy the matching code.
