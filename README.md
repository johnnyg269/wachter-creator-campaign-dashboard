# Wachter Creator Campaign Dashboard

Internal marketing dashboard tracking the **Cybernick0x × Wachter** creator campaign across **TikTok, YouTube Shorts, Instagram Reels, and Facebook Reels**. It pulls per-video metrics (views, likes, comments, shares, saves) on a schedule, stores time-series snapshots, ingests and classifies comments, groups videos into episodes, and raises alerts when something spikes, stalls, or breaks.

Dark-mode, server-rendered, built for a leadership audience: every number shows where it came from, how fresh it is, and "Unavailable" — never a fake zero — when a platform doesn't expose a metric.

## Routes

| Route | What it shows |
|---|---|
| `/` | Campaign overview — KPIs, per-platform stats, momentum trends, top videos, open alerts |
| `/videos` | Every tracked video with latest metrics, deltas, engagement rate, episode assignment |
| `/comments` | Comment stream with sentiment, keyword tags, and "needs response" flags |
| `/platforms` | Per-platform health: provider status, profile, discovery state, metric coverage |
| `/episodes` | Episode groups (content series) with rolled-up performance |
| `/alerts` | Alert inbox — spikes, new videos, failed refreshes, items needing review |
| `/admin` | Apify Setup (actor testing/assignment), data source health, campaign settings |

API routes: `POST /api/refresh` (manual refresh), `GET|POST /api/cron/refresh` (scheduled, secret-protected), `GET /api/status`, `POST /api/alerts/[id]/review`, `POST /api/videos/[id]/episode`.

## Security

**Use environment variables. Never commit secrets.** All credentials live in
`.env.local` locally (gitignored) and Vercel environment variables in
production. Run `npm run secrets:check` to scan tracked files for accidental
secret values — it fails the moment a real token, password, or connection
string lands in the repo.

## Quickstart

```bash
npm install
cp .env.example .env.local
# edit .env.local → set APIFY_TOKEN (and optionally YOUTUBE_API_KEY)
npm run dev
```

Open http://localhost:3000. The app works with **no** environment variables at all — every page renders with honest "not connected" statuses — but you need an `APIFY_TOKEN` (and tested actors, see [APIFY_SETUP.md](./APIFY_SETUP.md)) before live numbers appear.

For local exploration without any credentials, set `MOCK_DATA=1` in `.env.local` to load clearly-labeled demo data. Never enable this in production.

## How seeding works

Seeding is **automatic and idempotent** — it runs on first page load and at the start of every refresh, so there is no setup step. It creates the campaign, the four platform profiles, the four seed videos, and the default episode groups:

| Platform | Seed video | Seed profile |
|---|---|---|
| TikTok | `tiktok.com/@cybernick0x/video/7649233656807968014` | `tiktok.com/@cybernick0x` |
| YouTube Shorts | `youtube.com/shorts/CL62fTyvMOY` | `youtube.com/@cybernick0x/shorts` |
| Facebook Reels | `facebook.com/reel/1268008372073152` | `facebook.com/people/Cybernick0x/61585540862384/?sk=reels_tab` |
| Instagram Reels | `instagram.com/cybernick0x/reel/DZWaZjlggrV/` | `instagram.com/cybernick0x` |

Seed URLs live in `src/lib/config.ts` (`SEED_VIDEOS` / `SEED_PROFILES`). The campaign start date is learned automatically from the earliest seed video publish date once metrics arrive (admin-editable).

## Refreshing data

A refresh runs the full pipeline per platform — discover new posts from the profile, upsert videos, capture a metrics snapshot per video, ingest + classify comments — then scans for alerts and records a `RefreshRun`. Failures are isolated per platform: one broken source never blanks the rest.

Four ways to trigger it:

1. **UI** — the Refresh button in the header (calls `POST /api/refresh`).
2. **API** — `curl -X POST http://localhost:3000/api/refresh`
3. **CLI** — `npm run refresh` (same pipeline, prints a per-platform report).
4. **Cron** — `GET`/`POST /api/cron/refresh`, protected by `CRON_SECRET` (bearer header). The endpoint answers `202` immediately and refreshes in the background. **Primary scheduler: cron-job.org** ("Wachter Campaign Dashboard Refresh", every 5 minutes); GitHub Actions runs as a 30-minute best-effort backup. Public viewers are read-only — they never trigger refreshes or Apify spend; a database-backed lock prevents overlapping runs; all viewers read the same shared Supabase data. See [DEPLOYMENT.md](./DEPLOYMENT.md).

Concurrent triggers are serialized — a second trigger while one is running awaits the in-flight run.

## Connecting data sources

- **YouTube**: set `YOUTUBE_API_KEY` (official Data API v3 — preferred) or assign an Apify YouTube actor.
- **TikTok / Instagram / Facebook**: set `APIFY_TOKEN`, then test and assign an actor per platform in `/admin → Apify Setup`. Six pre-identified candidate actors are built in. Full walkthrough: [APIFY_SETUP.md](./APIFY_SETUP.md).

What each source can and cannot provide: [DATA_SOURCES.md](./DATA_SOURCES.md) and [PLATFORM_LIMITATIONS.md](./PLATFORM_LIMITATIONS.md).

## Storage modes

| Mode | When | Notes |
|---|---|---|
| **JSON file store** | `DATABASE_URL` unset (default) | Writes `./data/local-db.json`. Fine for local dev. On Vercel it can only write `/tmp`, which is wiped between invocations — the UI warns that data is ephemeral. |
| **Postgres (Prisma)** | `DATABASE_URL` set | Recommended for any deployment. Supabase pooled connection string works well. Push the schema with `npm run db:push`. |

The store is selected automatically at runtime in `src/lib/store/index.ts`; no code changes needed to switch.

## Testing

```bash
npm test              # vitest unit tests
npm run test:actors   # live-test candidate Apify actors against the seed URLs
                      # (requires APIFY_TOKEN; persists results to provider config)
npm run test:actors -- tiktok                     # one platform
npm run test:actors -- tiktok GdWCkxBtKWOsKjdch   # one specific actor
```

## Deploying

Vercel + Supabase walkthrough, full environment variable table, cron setup (including the Hobby-plan limitation and external-scheduler fallback): [DEPLOYMENT.md](./DEPLOYMENT.md).

**Set `ADMIN_PASSWORD` before deploying** — without it, `/admin` is open.

## Documentation

- [DATA_SOURCES.md](./DATA_SOURCES.md) — per-platform source matrix, null-vs-zero policy, source statuses
- [APIFY_SETUP.md](./APIFY_SETUP.md) — token, candidate actors, testing, field mapping, troubleshooting
- [DEPLOYMENT.md](./DEPLOYMENT.md) — Vercel, Supabase, env vars, cron
- [PLATFORM_LIMITATIONS.md](./PLATFORM_LIMITATIONS.md) — honest constraints and the compliance posture
