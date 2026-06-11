# Platform Limitations

What this dashboard can and cannot promise, per platform. Read this before presenting numbers to leadership — the short version: **YouTube is authoritative, the other three are best-effort scrapes, and anything the app can't verify it shows as "Unavailable" rather than inventing.**

## Reliability tiers

| Tier | Platforms | Why |
|---|---|---|
| **Official API** | YouTube Shorts (with `YOUTUBE_API_KEY`) | Google's Data API v3 — stable contract, documented fields, quota-cheap. The most reliable numbers in the app. |
| **Scraper actors** | TikTok, Instagram Reels, Facebook Reels (and YouTube without an API key) | Apify Store actors that scrape public pages. They work well, but nothing about them is guaranteed. |

## Scraper realities (TikTok / Instagram / Facebook)

- **Output schemas change without notice.** Actors update when platforms change their markup or internal APIs; field names move (`playCount` → `stats.playCount`, captions nested under `message.text`, etc.). This is why the normalizer (`src/lib/apify/normalize.ts`) is defensive — it probes a long list of known field paths per metric and leaves anything unrecognized as `null` — and why `/admin` shows the **detected fields** from the last actor test, so a schema drift is visible the moment it happens instead of silently zeroing metrics.
- **Actors can break entirely.** A platform-side change can make an actor return 0 items or fail until its maintainer ships a fix. The dashboard surfaces this as `Last refresh failed` with the error message, keeps the last good snapshot, and the per-platform isolation means the other platforms keep refreshing.
- **Rate limits and credits.** Every actor run consumes Apify platform credits (free tier ≈ $5/month of usage). A `*/10` cron running up to ~2 actor runs per platform adds up — watch Apify Console → Usage. If credits run out, refreshes fail with rate-limit/credit errors until the next billing cycle or a plan upgrade. Actor runs are also internally capped (~4 min per run, bounded retries) so a stuck run never burns credits indefinitely.

## Metrics that simply don't exist per platform

Some metrics are not exposed by the platform to anyone — no actor or API can get them:

| Platform | Not available | Notes |
|---|---|---|
| YouTube | Shares, saves | The Data API v3 does not expose share/save counts at all. |
| Instagram | Saves | Not exposed publicly; would require Meta Graph API insights with business permissions. |
| Facebook | Saves | Same — public reel pages don't show save counts. "Likes" are total reactions. |
| TikTok | — | The recommended actor covers views, likes, comments, shares, and saves (`collectCount`). |

These render as "Unavailable" / "—" throughout the UI. **The dashboard never substitutes 0 for a metric the platform didn't report** — see the null-vs-zero policy in [DATA_SOURCES.md](./DATA_SOURCES.md).

## Discovery limitations

"Discovery" = finding new campaign videos automatically from the creator's profile.

- **YouTube (Apify fallback)**: the candidate actor is **channel-based only** — it scrapes the channel's Shorts feed and cannot fetch an arbitrary single video URL. A tracked video missing from the channel sweep simply keeps its last snapshot (its `lastRefreshedAt` shows the staleness). The official API has no such limitation.
- **Facebook**: reels discovery depends on the **page/profile URL form** — the seed uses the `facebook.com/people/…/?sk=reels_tab` URL. If the page URL changes shape (vanity URL, page migration), discovery may stop finding new reels until the profile URL is updated.
- **Instagram/TikTok**: profile sweeps are capped (≈30–50 most recent posts) and date-filtered to the campaign start; a very high posting volume could outpace a sweep, though that's unlikely for this campaign.
- New-video detection only sees what actors return — a post made private, geo-blocked, or age-gated may never appear.

## Comment limitations

Comment ingestion exists only where the source provides it: always on YouTube (official API), on TikTok via the recommended actor (up to ~15 comments per post — a sample, not the full thread), and on Instagram/Facebook only if the assigned actor embeds comments. Sentiment/needs-response classification is keyword-based — useful triage, not ground truth.

## Honesty guarantees

- Missing metric → "Unavailable", never 0 or an estimate.
- Every number is traceable: source status badge, last-refreshed timestamp, and the raw payload stored per video for auditing.
- Failed refreshes are loud (alerts + status pills), and stale data is visibly stale rather than silently re-presented as current.
- Demo mode (`MOCK_DATA=1`) is labeled as demo data everywhere it appears.

## Compliance

- Use **platform-compliant data sources** and respect each platform's Terms of Service. The app only reads **public** data (public posts, public counts, public comments) — no login simulation, no private data, no PII beyond public usernames on public comments.
- Scraping sits in a gray zone that platforms can tighten at any time; treat the Apify actors as a pragmatic interim, not the end state.
- **Prefer official APIs as they become available.** The upgrade path is already stubbed in `.env.example`:
  - **Meta Graph API** (`META_ACCESS_TOKEN`, `META_IG_USER_ID`, `META_PAGE_ID`) — first-party Instagram/Facebook insights, including metrics scrapers can never see (reach, saves). Requires a Meta app, business verification, and the creator's page/account connection.
  - **TikTok official APIs** (`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_ACCESS_TOKEN`) — Display/Research API access, requiring an approved TikTok developer app.
  - YouTube already uses the official API when a key is present.

When official access lands, swap the provider per platform and retire the corresponding actor — the provider abstraction (`src/lib/providers/`) was built for exactly that.
