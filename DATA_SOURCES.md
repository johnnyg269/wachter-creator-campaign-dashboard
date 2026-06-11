# Data Sources

How each platform's numbers get into the dashboard, what each source can actually provide, and how to read source statuses.

## Provider resolution

Per platform, on every refresh (`src/lib/providers/registry.ts`):

1. `MOCK_DATA=1` → **Mock provider** (clearly-labeled demo data, local dev only)
2. YouTube + `YOUTUBE_API_KEY` set → **official YouTube Data API v3** (always preferred for YouTube)
3. `APIFY_TOKEN` + an assigned actor → **Apify provider**
4. Otherwise → **Manual provider** with an explanatory status (`Needs Apify token`, `Actor not configured`, …) — the platform is skipped, not faked.

## Source matrix

| Platform | Primary source | Views | Likes | Comments count | Shares | Saves | Comment text | Discovery |
|---|---|---|---|---|---|---|---|---|
| YouTube Shorts | YouTube Data API v3 (official) | Yes | Yes | Yes | **No** — not exposed by the API | **No** | Yes (`commentThreads`) | Yes (uploads playlist) |
| YouTube Shorts (fallback) | Apify `streamers/youtube-shorts-scraper` | Yes | Varies | Varies | No | No | No | Channel-based only |
| TikTok | Apify `clockworks/tiktok-scraper` | Yes (`playCount`) | Yes (`diggCount`) | Yes | Yes | Yes (`collectCount`) | Yes (`commentsPerPost`) | Yes (profile) |
| Instagram Reels | Apify `apify/instagram-reel-scraper` | Yes | Yes | Yes | Yes (`includeSharesCount`) | **No** — not exposed | Varies by actor | Yes (profile) |
| Facebook Reels | Apify `apify/facebook-posts-scraper` | Yes | Yes (reactions) | Yes | Yes | **No** | Varies by actor | Yes (page URL) |

"Varies" means it depends on the assigned actor's output — the admin actor test detects what an actor actually returns (see capability badges in [APIFY_SETUP.md](./APIFY_SETUP.md)).

## YouTube — official API (preferred)

When `YOUTUBE_API_KEY` is set, YouTube uses the Data API v3 directly (`src/lib/providers/youtube-api-provider.ts`). It is the most reliable source in the app and quota-cheap:

- `videos.list` (snippet + statistics) — title, description, thumbnail, publish date, view/like/comment counts (up to 50 IDs per call)
- `commentThreads.list` — top-level comment text, author, likes, reply counts (comments disabled on a video are treated as "no comments", not a failure)
- `channels.list` + `playlistItems.list` — discovery of new uploads via the channel's uploads playlist

The API does **not** expose share or save counts — those render as "Unavailable" by design.

Get a key: Google Cloud Console → enable "YouTube Data API v3" → create an API key.

Without a key, YouTube falls back to the Apify Shorts scraper, which is channel-based (it scrapes the channel's Shorts feed and matches video IDs afterwards — it cannot fetch a single arbitrary video URL).

## TikTok / Instagram / Facebook — Apify actors

No official API access is configured for these platforms today, so they rely on Apify Store actors. Six candidates were identified and tested at kickoff (`CANDIDATE_ACTORS` in `src/lib/config.ts`); details and IDs in [APIFY_SETUP.md](./APIFY_SETUP.md). What the tested candidates return:

- **TikTok** (`clockworks/tiktok-scraper`) — the richest scraper: post URLs and profile sweeps, full metric set including saves, and up to 15 comments per post embedded in the result. The free alternate (`clockworks/free-tiktok-scraper`) drops per-post comments.
- **Instagram** (`apify/instagram-reel-scraper`) — reel metadata + play/like/comment counts; share counts when `includeSharesCount` is on; saves are not exposed by Instagram to scrapers. The alternate (`hpix/ig-reels-scraper`) uses a different input schema (`target`/`reels_count`).
- **Facebook** (`apify/facebook-posts-scraper`) — page/profile posts including reels; reactions, comment and share counts arrive in GraphQL-shaped nested fields, which the normalizer knows how to read.

Actor output schemas are **not contractual** — they can change without notice. The normalizer (`src/lib/apify/normalize.ts`) is deliberately defensive, probing many known field paths and leaving anything unrecognized as `null`.

## What requires official platform permissions

Some data is only available through official platform APIs that require app review / business verification. The env vars are reserved in `.env.example` as the upgrade path, but **no code uses them yet**:

| Env var | Would unlock |
|---|---|
| `META_ACCESS_TOKEN`, `META_IG_USER_ID`, `META_PAGE_ID` | Meta Graph API: first-party Instagram/Facebook insights (reach, saves, true share counts) |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_ACCESS_TOKEN` | TikTok official Display/Research APIs |

When the campaign gains these permissions, official APIs should replace the corresponding scrapers (see [PLATFORM_LIMITATIONS.md](./PLATFORM_LIMITATIONS.md)).

## Null vs. zero — the honesty policy

**A missing metric is `null`, rendered as "Unavailable" or "—". It is never coerced to 0.**

This matters for exec reporting: "0 shares" says the content failed to spread; "shares unavailable" says the platform doesn't report it. Conflating the two makes platforms that hide a metric look like they're underperforming, and corrupts totals, engagement rates, and period-over-period deltas. The rule is enforced at every layer:

- The normalizer leaves unrecognized fields `null` rather than defaulting to 0.
- `MetricSnapshot` columns are nullable; engagement rate is `null` when not computable.
- UI components (`KpiCard`, `DeltaTag`) have built-in unavailable states.

Aggregates only sum metrics that are actually present, and freshness (last refresh / snapshot time) is shown alongside numbers so stale data is never mistaken for current data.

## Source statuses

Every video and platform card carries a `SourceStatus` so live-vs-not-connected is always obvious:

| Status | Label | Meaning |
|---|---|---|
| `live` | Live | Data is flowing from a working provider |
| `needs_api_key` | Needs API key | YouTube: set `YOUTUBE_API_KEY` (or configure an Apify actor) |
| `token_connected` | Apify token connected | Token valid; further setup in progress |
| `actor_not_configured` | Actor not configured | Token works, but no actor assigned for this platform — go to `/admin → Apify Setup` |
| `needs_apify_token` | Needs Apify token | Set `APIFY_TOKEN` in `.env.local` / Vercel env vars |
| `needs_auth` | Needs auth | Source requires credentials that aren't present |
| `manual_required` | Manual add required | No automated source can cover this; data must be entered by hand |
| `refresh_failed` | Last refresh failed | The provider errored on the most recent run (error message stored on the video) |
| `demo` | Demo data | `MOCK_DATA=1` — numbers are fabricated and labeled as such |
| `waiting` | Waiting for first refresh | Source is configured; no snapshot captured yet |

## Comment support varies by actor

Comment ingestion depends entirely on whether the assigned actor embeds comments in its output (TikTok's recommended actor does; many others don't). The YouTube official API always supports comments. When an actor is tested in `/admin`, the **comments** capability badge reflects what was actually detected — if it's off, the Comments page simply won't receive new comments for that platform, and nothing is fabricated. Ingested comments are keyword-tagged and sentiment-classified (`positive` / `neutral` / `negative` / `question`), with likely-needs-a-reply comments flagged.
