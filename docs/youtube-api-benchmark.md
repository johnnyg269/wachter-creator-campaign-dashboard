# YouTube Data API vs Apify — benchmark & decision

**Question:** can the official YouTube Data API replace the Apify
`streamers/youtube-shorts-scraper` for YouTube Shorts metrics, returning the
fields the dashboard / charts / reports / video cards need?

**Answer: yes — and the app already uses it.** YouTube was wired to the
official API in an earlier phase; the Apify YouTube scraper is fallback-only
(used only when no `YOUTUBE_API_KEY` is configured). This pass verified that
end-to-end, separated comment pulls from metric pulls, and surfaced provider
state in admin.

## How this was benchmarked (no Apify credits spent)

The real `YOUTUBE_API_KEY` lives **only in Vercel Production** (by design — it
is never committed and `.env.local` holds an empty placeholder, so a local
process cannot call the API or leak the key). The comparison therefore used:

1. **Stored Apify rawJson** for the two tracked Shorts (`CL62fTyvMOY`,
   `gy6jWRj1CuQ`) already in the database — the field reference. Apify returns:
   `title`, `thumbnailUrl`, `date`, `viewCount`, `likes`, `commentsCount`,
   `channelName` (no share count).
2. **Live production telemetry** — `/api/status` reports YouTube as
   `providerType: "youtube_api"`, `actorId: null`, `sourceStatus: "live"`, with
   a recent successful refresh; the production `/videos` page renders both
   Shorts with their API-sourced **titles and metrics**. This proves the API
   returns usable, complete data in the live environment.
3. A **unit test** (`tests/youtube-api.test.ts`) feeds a real-shaped
   `videos.list` response (`part=snippet,statistics`) through the provider and
   asserts every required field is normalized.

`scripts/youtube-benchmark.ts` automates (1) and, when run in an environment
where the key IS present (e.g. production), performs the live (2)-style
`videos.list` call and prints a field-by-field table. Run locally it reports
that the key is absent and falls back to the stored-data reference.

## Field coverage

| Field | YouTube Data API | Apify shorts scraper | Needed by app |
| --- | --- | --- | --- |
| video id | yes (`id`) | yes | yes |
| title | yes (`snippet.title`) | yes | yes |
| description | yes (`snippet.description`) | yes | optional |
| publishedAt | yes (`snippet.publishedAt`) | yes (`date`) | yes |
| thumbnail | yes (`snippet.thumbnails.*`) | yes | yes |
| views | yes (`statistics.viewCount`) | yes (`viewCount`) | yes (primary) |
| likes | yes (`statistics.likeCount`, hidden if uploader disables) | yes | yes |
| comment count | yes (`statistics.commentCount`, absent if comments off) | yes | yes |
| channel | yes (`snippet.channelTitle`) | yes (`channelName`) | optional |
| shares | no (YouTube has no public share count) | no | n/a |

The API returns **all required fields**. The only gap (shares) is also absent
from Apify and from YouTube itself, so it is not a regression. `likeCount` /
`commentCount` can legitimately be absent per-video (uploader hid likes /
disabled comments); the provider maps those to `null` (never `0`), so the
last-known-good and "Unavailable is not 0" rules hold.

## Decision (2C)

- **YouTube metric refresh uses the official YouTube Data API.** Routing in
  `src/lib/providers/registry.ts`: `youtube + YOUTUBE_API_KEY -> YouTubeApiProvider`.
- **Apify YouTube scraper is fallback-only** — selected only when no key is set.
  It does **not** run on normal production refreshes.
- Last-known-good, monotonic-view, thumbnail-persistence, and snapshot
  protections live in the shared refresh pipeline and apply identically to
  API-sourced YouTube data.
- **Comment detail** (commentThreads) is now gated to the once-per-day comment
  cycle, not pulled on every metrics refresh (see cost-controls).

## Cost impact

- YouTube metrics cost **0 Apify actor runs** on normal refreshes. The YouTube
  Data API quota is free at 10,000 units/day; `videos.list` = **1 unit** per
  refresh, `commentThreads` = **1 unit** per video on the daily comment cycle —
  effectively free vs. the prior ~1 Apify run/refresh for YouTube.
- That removes roughly **18–24 Apify runs/day** for YouTube alone (~$0.36–
  $0.48/day), on top of the comment/discovery reductions documented in the
  cost-controls notes.
