# Apify Setup

The dashboard pulls TikTok, Instagram Reels, Facebook Reels — and YouTube Shorts when no
`YOUTUBE_API_KEY` is set — through [Apify](https://apify.com) actors. Setup is **token-first**:
add `APIFY_TOKEN` and the app runs; each platform then shows "Actor not configured" until you
assign and test an actor in `/admin → Apify Setup`.

## 1. Get a token

1. Create an account at [console.apify.com](https://console.apify.com).
2. Go to **Settings → API & Integrations → Personal API tokens** and copy the token.

## 2. Where the token goes

- **Local:** `.env.local` → `APIFY_TOKEN=...` (this file is gitignored — never commit it).
- **Production:** Vercel → Project → **Settings → Environment Variables** → `APIFY_TOKEN`.

The token never appears in the client bundle, the admin UI, or logs — the app only shows
*connected / missing / invalid* status (errors are scrubbed of the token before display).
If a token ever leaks (e.g. pasted into a chat or commit), rotate it in the Apify console.

## 3. Verified actors for this campaign

These were tested live against the campaign seed URLs (2026-06-10) and are pre-filled as
candidates in `/admin → Apify Setup`:

| Platform | Actor | ID | Result |
|---|---|---|---|
| TikTok | `clockworks/tiktok-scraper` | `GdWCkxBtKWOsKjdch` | ✓ metadata, metrics, comments (side dataset), profile discovery |
| TikTok (alt) | `clockworks/free-tiktok-scraper` | `OtzYfK1ndEGdwWFKQ` | ✓ same data, no per-post comment options |
| Instagram | `apify/instagram-reel-scraper` | `xMc5Ga1oCONPmWJIa` | ✓ metadata, metrics, `latestComments`, discovery |
| Instagram (alt) | `hpix/ig-reels-scraper` | `PE8EVAh0QG4mH6cLP` | ✗ HTTP 403 — requires paid rental; not usable as-is |
| Facebook | `apify/facebook-posts-scraper` | `KoJrdxJCTtpon81KY` | ✓ metadata, likes/comments/shares (reel **views not exposed** → shown as Unavailable) |
| YouTube | `streamers/youtube-shorts-scraper` | `WT1BVWatl2aHVeFEH` | ✓ metadata + metrics via channel scrape (no individual-URL mode, no comments) |

## 4. Assigning and testing an actor

In `/admin → Apify Setup`, each platform card lets you:

1. **Paste an Actor ID** — either `username~actor-name` or the raw ID (`GdWCkxBtKWOsKjdch`).
2. **Save** — persists to the app database (`ProviderConfig`). A changed actor resets to
   "untested" until you re-test it.
3. **Test actor** — runs the actor against the platform's seed URL (YouTube uses the channel
   URL since its actor is channel-based), waits for completion (1–3 minutes), fetches the
   dataset, and shows:
   - the exact **input JSON** that was sent (expandable),
   - **item count** and run duration,
   - **detected fields** in the raw output,
   - a **normalized preview** (views/likes/comments/shares/title/published),
   - capability badges: Metadata / Metrics / Comments / Discovery,
   - the error, plainly, if anything failed.

Nothing is marked *live* until a test passes. Failed actors show their failure; the dashboard
never substitutes fake data.

### Production env vars

Saving in admin persists actor IDs to the database. For production, also set them as Vercel
environment variables so a fresh database starts configured (runtime config takes precedence):

```
APIFY_TIKTOK_ACTOR_ID=GdWCkxBtKWOsKjdch
APIFY_INSTAGRAM_ACTOR_ID=xMc5Ga1oCONPmWJIa
APIFY_FACEBOOK_ACTOR_ID=KoJrdxJCTtpon81KY
APIFY_YOUTUBE_ACTOR_ID=WT1BVWatl2aHVeFEH
```

## 5. Input formats and overrides

Actors disagree about input shape. The app ships exact input builders for the six verified
actors (pulled from their published input schemas). For unknown actors it tries common
patterns, capped at **3 attempts** per test so Apify is never hammered:

```
{ "startUrls": [{ "url": "..." }] }   { "startUrls": ["..."] }   { "directUrls": ["..."] }
{ "urls": ["..."] }                   { "url": "..." }           { "videoUrls": ["..."] }
{ "postUrls": ["..."] }
```

If an actor needs something unusual, open **Input override (advanced)** on its platform card
and paste the full input JSON — it is used verbatim for tests and refreshes.

## 6. Field mapping (what the normalizer looks for)

Actor outputs vary; the normalizer checks alternatives in order and leaves a metric `null`
("Unavailable") when nothing matches — never zero:

- **views:** `views`, `viewCount`, `playCount`, `videoViewCount`, `videoPlayCount`, `stats.playCount`, …
- **likes:** `likes`, `likeCount`, `diggCount`, `likesCount`, `stats.diggCount`, `likers.count`, `unified_reactors.count`, …
- **comments:** `comments`, `commentCount`, `commentsCount`, `total_comment_count`, `stats.commentCount`, …
- **shares:** `shares`, `shareCount`, `sharesCount`, `share_count_reduced`, …
- **saves:** `saves`, `collectCount`, `stats.collectCount`, `bookmarks`, …
- **caption/title:** `text`, `caption`, `description`, `title`, `videoDescription`, `message.text`, …
- **thumbnail:** `thumbnail(Url)`, `cover(Url)`, `displayUrl`, `imageUrl`, `videoMeta.coverUrl`, FB's `preferred_thumbnail.image.uri`, …
- **published:** `createTime(ISO)`, `timestamp`, `takenAt`, `publishedAt`, `uploadDate`, `creation_time` (unix seconds OK), …
- **comment lists:** embedded `comments` / `latestComments` / `topComments`, or clockworks' `commentsDatasetUrl` side dataset.

**If an actor changes its output:** the platform's metrics start showing Unavailable. Open
`/admin → Apify Setup`, hit **Test actor**, and inspect *detected fields*. Usually either the
actor renamed a field (extend `src/lib/apify/normalize.ts`'s path lists) or its input changed
(set an input override). Swapping to a different Store actor is the third option.

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Apify token invalid" | Token revoked or mistyped — rotate in console, update env var |
| "Actor not found or not accessible" (404) | Wrong ID, actor renamed/unpublished, or it's private |
| HTTP 403 starting a run | Paid/rental actor not rented on your account (e.g. `hpix/ig-reels-scraper`) |
| Run timeout (~3 min cap) | Actor too slow for the input — lower `resultsLimit`/discovery limit, or pick a faster actor |
| "returned 0 items" | Wrong input shape for this actor — use the input override |
| "output could not be mapped" | Output schema unknown — check detected fields, extend the normalizer |
| Rate limits / credit errors | Check usage at console.apify.com → Billing; the 10-min cron costs ~144 runs/platform/day — consider widening the cron interval if credits are a concern |
