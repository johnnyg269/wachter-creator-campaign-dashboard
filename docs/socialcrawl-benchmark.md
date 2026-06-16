# SocialCrawl benchmark — replacing the non-YouTube Apify actors

**Date:** 2026-06-15 · **Status:** benchmark only (no production switch, no Vercel changes, no routing changes)

Goal: can [SocialCrawl](https://www.socialcrawl.dev) replace Apify for **TikTok, Instagram, and Facebook** metrics while **YouTube stays on the official YouTube Data API** — and critically, does it return the **public Facebook Reel plays** that the Apify `facebook-posts-scraper` does not?

The benchmark key was used **locally only** (`.env.local`, untracked), never printed, never committed, never sent to Vercel, never `NEXT_PUBLIC`. **Rotate it after the benchmark** (it was shared in chat).

## API shape (discovered)
- Base URL `https://www.socialcrawl.dev/v1`, auth header `x-api-key`.
- Response envelope: `{ success, platform, endpoint, data, credits_used, credits_remaining, request_id, cached }`. **1 credit/call; cache hits cost 0.**
- Per-post shape: `data.<post>` with `post.engagement.{views,likes,comments,shares,saves}`, `post.content.{text,thumbnail_url,media_urls,duration_seconds}`, `post.published_at`, `post.id`, `post.url`, `post.author.*`. **One unified schema across platforms.**
- Endpoints used: `GET /tiktok/profile/videos?handle=`, `GET /instagram/profile/reels?handle=`, `GET /facebook/profile/reels?url=`, `GET /facebook/post?url=` (full FB engagement), `GET /credits/balance`.
- `POST /v1/prism/post-stats` (the batch endpoint) **exists but returns `status:"unsupported"`** for these post URLs — not usable. The per-platform profile endpoints are the path.

## Endpoint results
| Endpoint | Returns | Views = public? | Likes | Comments | Shares | Thumb | Caption | Date | ID/URL |
|---|---|---|---|---|---|---|---|---|---|
| `tiktok/profile/videos` | 10 videos | yes (matches Apify) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `instagram/profile/reels` | 12 reels | yes (matches Apify) | ✅ | ✅ | — (IG has none) | ✅ | ✅ | ✅ | ✅ |
| `facebook/profile/reels` | 10 reels | **YES — public plays** | — (list) | — (list) | — (list) | ✅ | ✅ | ✅ | ✅ |
| `facebook/post` (per reel) | 1 reel | **YES — public plays** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Facebook is the headline.** The Apify actor returns a stricter `viewsCount`; SocialCrawl returns the public Reel **plays** the cards show:

| FB reel | Apify `viewsCount` | SocialCrawl plays | Public card (user) |
|---|---|---|---|
| 1361860342502757 | 41,041 | **128,000** | ~124K ✅ |
| 1622932512112198 | 55,178 | **91,000** | ~90K ✅ |
| 1268008372073152 | 2,073 | **4,400** | ~4.3K ✅ |
| 952156501124577 | 2,080 | **4,200** | ~4.2K ✅ |

(Apify's `viewsCount` is not only ~half — it isn't even correctly *ordered* vs the real plays.)

## Shadow refresh — current (Apify) vs SocialCrawl, matched by stable ID
| Platform | Current (Apify) | Shadow (SocialCrawl) | Matched | Note |
|---|---|---|---|---|
| TikTok | 791,784 | 792,206 | 5/5 | +0.05% — essentially identical, both accurate |
| Instagram | 800,971 | 801,884 | 5/5 | +0.1% — essentially identical |
| **Facebook** | 101,587 | **230,300** | 6/6 | **+127%** — real public plays |
| TT+IG+FB | 1,694,342 | **1,824,390** | 16/16 | YouTube unchanged (Data API) |

TikTok/Instagram prove SocialCrawl is **accurate and at parity** with Apify; Facebook proves it **fixes** the undercount. Engagement: TikTok full (incl. shares), Instagram views+likes+comments (no shares — same as today), Facebook full via `facebook/post` (the reels *list* returns views only).

## Cost (active hours 6 AM–midnight ET = 18h/day; 1 credit/call; cache hits free)
**Scenario A — Prism `post-stats` only:** not viable (endpoint returns `unsupported`).

**Scenario B — 3 profile calls/refresh (TikTok+IG+FB):**
| Cadence | credits/day | credits/month | Plan |
|---|---|---|---|
| 60 min | 54 | ~1,620 | **Starter** (2,500) |
| 30 min | 108 | ~3,240 | Growth (20,000) |
| 15 min | 216 | ~6,480 | Growth |

(+ optional FB likes/comments via `facebook/post` once/day for the tracked reels ≈ **+180/month** — still within Starter at 60 min.)

**Scenario C — Facebook only (TikTok/IG stay Apify):**
| Cadence | credits/month | Plan |
|---|---|---|
| 60 min | ~540 | Starter |
| 30 min | ~1,080 | Starter |

**Plans:** Free 100 one-time · Starter 2,500 / £15 (~$19) · Growth 20,000 / £49 (~$62).
**Current Apify:** ~$1.2–1.5/day = **~$36–45/month**.

➡️ At the app's current **60-minute** cadence, **SocialCrawl Starter (£15 ≈ $19/mo) replaces all three non-YouTube actors, is more accurate (real FB plays), and is ~50% cheaper than Apify.** Growth is only needed for 30/15-minute cadence.

## Recommendation
**Replace all non-YouTube Apify metrics with SocialCrawl profile-endpoint routing** (TikTok/IG/FB), keep **YouTube on the Data API**, keep **Apify as fallback only**, behind a feature flag. Plan: **Starter**. This both cuts cost and fixes the Facebook accuracy problem.

## Risks / caveats
- **FB reels list = views only**; likes/comments/shares need `facebook/post` (extra credits) — fold into the existing once-a-day comment-detail tier.
- **Rounded FB plays** (128K/91K) — public-display rounding; fine for a board view, but FB growth deltas will be coarse.
- **Profile-list windows** return the ~10–12 most recent posts; older tracked posts could fall off the window and need a per-post call. Today all tracked posts are within the window (16/16 matched).
- **Cache behavior** is opaque (TTL unknown); credit estimates assume no cache benefit (worst case).
- **Reliability/rate limits** not stress-tested beyond this benchmark; keep Apify as fallback + last-known-good + monotonic protection.
- Keep nulls as "Unavailable" (never zero); keep quiet hours + budget cap.

## Production integration plan (NOT implemented — needs approval)
1. **Env:** `SOCIALCRAWL_API_KEY` (server-only), `SOCIALCRAWL_METRICS_ENABLED=false`, `NON_YOUTUBE_METRICS_PROVIDER=apify|socialcrawl`, `FACEBOOK_METRICS_PROVIDER=apify|socialcrawl`.
2. **Provider:** add `SocialCrawlProvider implements SocialPlatformProvider` (a `fetchPlatform` that calls the profile endpoints + per-post for FB engagement), normalizing into `NormalizedVideo` (mapper already written in `scripts/socialcrawl-shadow-refresh.ts`).
3. **Routing:** `registry.ts` chooses SocialCrawl vs Apify per the env flags; YouTube unchanged.
4. **Safety:** reuse existing **monotonic view protection**, **last-known-good** (empty-cycle guard, partial status), and the **view-resolver** (SocialCrawl `engagement.views` = exact confidence).
5. **Cost controls:** keep quiet hours + daily budget cap; the cap counts SocialCrawl calls (1 credit each); comment detail stays once/day (drives FB per-post).
6. **Admin:** extend provider-health to show active provider per platform + SocialCrawl credits remaining (via `/credits/balance`).
7. **Tests:** SocialCrawl normalizer maps the unified schema; FB returns plays; fallback to Apify on error; flags route correctly; no key in client bundle.
8. **Deploy:** add `SOCIALCRAWL_API_KEY` to Vercel (server env) **only on approval**, flip `NON_YOUTUBE_METRICS_PROVIDER=socialcrawl` (or `FACEBOOK_METRICS_PROVIDER=socialcrawl` first), verify live, keep Apify fallback for one cycle.

`scripts/socialcrawl-shadow-refresh.ts` is the non-destructive benchmark tool (dry-run, no Apify, no DB writes, key read from env + redacted).
