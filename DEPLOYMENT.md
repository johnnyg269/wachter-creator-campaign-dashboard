# Deployment

Target stack: **Vercel** (hosting + cron) and **Supabase** (Postgres). The app runs without a database, but on Vercel the JSON fallback writes to `/tmp`, which is wiped between invocations — set `DATABASE_URL` for any real deployment.

## 1. Vercel

1. Push the repo to GitHub/GitLab/Bitbucket.
2. Vercel → **Add New → Project** → import the repo. Framework preset: Next.js (auto-detected). No build settings to change (`npm run build`; `postinstall` runs `prisma generate` so the build never needs a live database).
3. Add the environment variables below (Project → Settings → Environment Variables) **before** the first deploy.
4. Deploy. `vercel.json` is picked up automatically, including the cron entry.

> **Set `ADMIN_PASSWORD` before deploying.** Without it, `/admin` — which can run actors and change provider config — is open to anyone with the URL.

## 2. Environment variables

All variables are read server-side only (none are exposed to the client except `NEXT_PUBLIC_APP_NAME`).

| Variable | Required | Where to get it / notes |
|---|---|---|
| `APIFY_TOKEN` | **Yes** (for TikTok/IG/FB data) | Apify Console → Settings → Integrations → API tokens. See [APIFY_SETUP.md](./APIFY_SETUP.md). |
| `DATABASE_URL` | **Yes on Vercel** | Supabase pooled Postgres connection string (section 3). Unset = ephemeral JSON store. |
| `CRON_SECRET` | **Yes** (for scheduled refresh) | Generate: `openssl rand -hex 24`. Vercel Cron sends it automatically as `Authorization: Bearer $CRON_SECRET`. Without it the cron endpoint refuses to run. |
| `ADMIN_PASSWORD` | **Strongly recommended** | Any strong secret. Gates `/admin`; if unset, `/admin` is open (acceptable for local dev only). |
| `YOUTUBE_API_KEY` | Recommended | Google Cloud Console → enable "YouTube Data API v3" → API key. Preferred YouTube source (more reliable than scraping). |
| `APIFY_TIKTOK_ACTOR_ID` | Recommended | Actor ID tested in `/admin → Apify Setup` (e.g. `GdWCkxBtKWOsKjdch`). Env vars survive a fresh database; admin-saved IDs live in the DB. |
| `APIFY_INSTAGRAM_ACTOR_ID` | Recommended | Same as above. |
| `APIFY_FACEBOOK_ACTOR_ID` | Recommended | Same as above. |
| `APIFY_YOUTUBE_ACTOR_ID` | Optional | Only used when `YOUTUBE_API_KEY` is not set. |
| `NEXT_PUBLIC_APP_NAME` | Optional | Display name; defaults to "Wachter Creator Campaign Dashboard". |
| `META_ACCESS_TOKEN`, `META_IG_USER_ID`, `META_PAGE_ID` | Optional (future) | Reserved for official Meta Graph API integration — unused today. |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_ACCESS_TOKEN` | Optional (future) | Reserved for official TikTok API integration — unused today. |
| `MOCK_DATA` | Never in production | `1` enables labeled demo data. Local dev only. |

## 3. Supabase (Postgres)

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine to start).
2. Project → **Connect** → copy the **Transaction pooler** connection string (port `6543`; pooled is the right choice for Vercel's serverless functions). Include your database password in the string.
3. Set it as `DATABASE_URL` in Vercel and in your local `.env.local`.
4. Push the schema once, from your machine:

   ```bash
   npx prisma db push
   ```

   (Or `npm run db:push`. If your pooler rejects DDL, run the push against the direct connection string, then switch `DATABASE_URL` back to the pooled one.)

The app picks the store at runtime: `DATABASE_URL` set → Prisma/Postgres; unset → JSON file store. No code changes, no migration step beyond `db push`.

## 4. Cron (scheduled refresh)

`vercel.json` ships:

```json
{ "crons": [{ "path": "/api/cron/refresh", "schedule": "*/10 * * * *" }] }
```

When `CRON_SECRET` is set, Vercel automatically sends `Authorization: Bearer $CRON_SECRET` with each cron invocation — no extra configuration. The endpoint rejects all requests (401) until `CRON_SECRET` is configured; it never runs as an unprotected public endpoint.

### Hobby plan limitation

**Vercel Hobby crons are limited** — Hobby allows only daily cron jobs (and timing is not exact), so the shipped `*/10` schedule will not run every 10 minutes on Hobby. Two options:

1. **Upgrade to Pro** — recommended. Pro supports the 10-minute schedule and longer function durations (see below).
2. **External scheduler fallback** — keep Hobby and have any external scheduler hit the endpoint. The route accepts `GET` or `POST`, with the secret either as a Bearer header or a `?secret=` query parameter:

   ```bash
   # Bearer header (preferred)
   curl -X GET "https://your-app.vercel.app/api/cron/refresh" \
     -H "Authorization: Bearer YOUR_CRON_SECRET"

   # Query-param fallback (for schedulers that can't set headers)
   curl "https://your-app.vercel.app/api/cron/refresh?secret=YOUR_CRON_SECRET"
   ```

   - **cron-job.org** — free; this is the **primary production scheduler**.
     Job 7793727 hits the endpoint every 5 minutes with the
     `Authorization: Bearer` header set under the job's advanced settings.
     The account API key lives in `.env.local` as `CRONJOB_ORG_API_KEY`;
     manage the job via `https://api.cron-job.org/jobs/7793727` or
     console.cron-job.org.
   - **GitHub Actions** — manual fallback only (`workflow_dispatch` in
     `.github/workflows/refresh.yml`); the cron schedule was removed because
     GitHub's scheduled workflows are best-effort and lagged badly:

     ```yaml
     # .github/workflows/refresh.yml
     name: Refresh dashboard data
     on:
       schedule:
         - cron: "*/10 * * * *"
       workflow_dispatch:
     jobs:
       refresh:
         runs-on: ubuntu-latest
         steps:
           - run: |
               curl --fail -X GET "https://your-app.vercel.app/api/cron/refresh" \
                 -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
     ```

### Function duration (`maxDuration`)

A full refresh runs Apify actors for up to four platforms and **can take several minutes** — each actor run has a hard internal budget of ~4 minutes. Both `/api/refresh` and `/api/cron/refresh` declare `maxDuration = 300` (5 minutes), but your plan caps what you actually get; on Hobby, long refreshes can be cut off mid-run. Failures are isolated per platform, so a timeout degrades rather than corrupts — but for reliable 10-minute crons plus full-length refreshes, **Vercel Pro is recommended**.

## 5. Post-deploy checklist

- [ ] `/` loads and every platform card shows an honest status (not errors)
- [ ] `/admin` prompts for the admin password
- [ ] `/admin → Apify Setup` shows a valid token and your assigned actors
- [ ] Trigger a manual refresh from the UI; confirm snapshots and `lastRefreshedAt` update
- [ ] `curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/refresh` returns `{ "ok": true, ... }`
- [ ] Confirm data survives a redeploy (it will only if `DATABASE_URL` is set)
