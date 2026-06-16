// SocialCrawl production integration — provider normalization (incl. Facebook
// PUBLIC plays), provider routing flags, Apify fallback-only behavior, monotonic
// protection of the higher SocialCrawl value, the new schedule (quiet 00:00–
// 07:00 ET, 15-min metrics, 2× comment detail), the daily credit cap, and
// no-secrets safety. Node test env.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocialCrawlProvider } from "@/lib/providers/socialcrawl-provider";
import { FallbackProvider } from "@/lib/providers/fallback-provider";
import { resolveProvider } from "@/lib/providers/registry";
import { metricsProviderFor, isSocialcrawlEnabled } from "@/lib/config";
import {
  decideScheduledRefresh,
  getRefreshPolicyConfig,
  isQuietHours,
  isCommentDetailDue,
  socialcrawlCreditsToday,
} from "@/lib/refresh-policy";
import { applyMonotonicViews } from "@/lib/metrics";
import type { PlatformProfile, RefreshRun } from "@/lib/types";
import type { Store } from "@/lib/store/types";
import type { SocialPlatformProvider, PlatformFetchResult } from "@/lib/providers/types";
import { makeVideo } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── helpers ──────────────────────────────────────────────────────────────────
const ENV_KEYS = [
  "SOCIALCRAWL_API_KEY",
  "SOCIALCRAWL_METRICS_ENABLED",
  "NON_YOUTUBE_METRICS_PROVIDER",
  "FACEBOOK_METRICS_PROVIDER",
  "SOCIALCRAWL_DAILY_CREDIT_CAP",
  "METRICS_REFRESH_INTERVAL_MINUTES",
  "QUIET_HOURS_END_ET",
  "COMMENT_DETAIL_PULL_1_ET",
  "COMMENT_DETAIL_PULL_2_ET",
] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

function profile(platform: PlatformProfile["platform"]): PlatformProfile {
  return {
    id: "p1",
    campaignId: "c1",
    platform,
    profileUrl:
      platform === "facebook"
        ? "https://www.facebook.com/people/Cybernick0x/61585540862384/"
        : `https://www.${platform}.com/cybernick0x`,
    handle: "cybernick0x",
    externalProfileId: null,
    lastDiscoveredAt: null,
    status: "live",
  };
}
const reel = (url: string, e: Record<string, number>) => ({
  post: {
    id: `id-${url.slice(-6)}`,
    url,
    content: { text: "caption", thumbnail_url: "https://img.example/t.jpg" },
    engagement: e,
    published_at: "2026-06-15T00:00:00.000Z",
    author: { display_name: "Cybernick0x", username: "cybernick0x" },
  },
});
/** Stub fetch returning canned SocialCrawl envelopes per endpoint. */
function stubFetch(byUrl: (url: string) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = byUrl(String(url));
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
}

// ── Provider normalization ───────────────────────────────────────────────────
describe("SocialCrawlProvider normalization", () => {
  beforeEach(() => (process.env.SOCIALCRAWL_API_KEY = "sc_test"));

  it("normalizes TikTok views + full engagement", async () => {
    stubFetch(() => ({
      data: { videos: [reel("https://www.tiktok.com/@cybernick0x/video/7650240034657848589", { views: 672067, likes: 24933, comments: 1151, shares: 3358 })] },
      credits_used: 1,
      cached: false,
    }));
    const out = await new SocialCrawlProvider("tiktok").fetchPlatform!(profile("tiktok"), [], new Date());
    expect(out.videos).toHaveLength(1);
    expect(out.videos[0].views).toBe(672067);
    expect(out.videos[0].likes).toBe(24933);
    expect(out.videos[0].shares).toBe(3358);
    expect(out.videos[0].externalVideoId).toBe("7650240034657848589");
  });

  it("normalizes Instagram views + likes/comments (no shares)", async () => {
    stubFetch(() => ({
      data: { reels: [reel("https://www.instagram.com/cybernick0x/reel/DZWaZjlggrV/", { views: 13529, likes: 208, comments: 3 })] },
      credits_used: 1,
      cached: false,
    }));
    const out = await new SocialCrawlProvider("instagram").fetchPlatform!(profile("instagram"), [], new Date());
    expect(out.videos[0].views).toBe(13529);
    expect(out.videos[0].externalVideoId).toBe("DZWaZjlggrV");
    expect(out.videos[0].shares).toBeNull();
  });

  it("normalizes Facebook PUBLIC Reel plays as views", async () => {
    stubFetch(() => ({
      data: { reels: [reel("https://www.facebook.com/reel/1361860342502757", { views: 128000 })] },
      credits_used: 1,
      cached: false,
    }));
    const out = await new SocialCrawlProvider("facebook").fetchPlatform!(profile("facebook"), [], new Date());
    expect(out.videos[0].views).toBe(128000); // public plays, not Apify viewsCount
    expect(out.videos[0].externalVideoId).toBe("1361860342502757");
    expect(out.videos[0].thumbnailUrl).toBe("https://img.example/t.jpg");
  });

  it("Facebook detail tier fetches per-post engagement for tracked reels only", async () => {
    const tracked = makeVideo({ id: "v1", platform: "facebook", originalUrl: "https://www.facebook.com/reel/1361860342502757", externalVideoId: "1361860342502757" });
    stubFetch((url) =>
      url.includes("/facebook/post")
        ? { data: { post: reel("https://www.facebook.com/reel/1361860342502757", { views: 128000, likes: 314, comments: 126, shares: 11 }).post }, credits_used: 1, cached: false }
        : { data: { reels: [reel("https://www.facebook.com/reel/1361860342502757", { views: 128000 })] }, credits_used: 1, cached: false },
    );
    const out = await new SocialCrawlProvider("facebook").fetchPlatform!(profile("facebook"), [tracked], new Date(), { wantComments: true });
    expect(out.videos[0].views).toBe(128000);
    expect(out.videos[0].likes).toBe(314);
    expect(out.videos[0].comments).toBe(126);
    expect(out.attempts.some((a) => a.kind === "detail")).toBe(true);
  });

  it("logs credit usage in the attempt (no schema change)", async () => {
    stubFetch(() => ({ data: { videos: [reel("https://www.tiktok.com/@x/video/1", { views: 5 })] }, credits_used: 1, cached: false }));
    const out = await new SocialCrawlProvider("tiktok").fetchPlatform!(profile("tiktok"), [], new Date());
    expect(out.attempts[0].provider).toBe("socialcrawl");
    expect(out.attempts[0].inputDescription).toMatch(/1cr/);
  });
});

// ── Routing flags ─────────────────────────────────────────────────────────────
describe("provider routing flags", () => {
  const fakeStore = { getProviderConfig: async () => null } as unknown as Store;

  it("routes TikTok/Instagram/Facebook to SocialCrawl when enabled", async () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    process.env.NON_YOUTUBE_METRICS_PROVIDER = "socialcrawl";
    process.env.FACEBOOK_METRICS_PROVIDER = "socialcrawl";
    expect(isSocialcrawlEnabled()).toBe(true);
    for (const p of ["tiktok", "instagram", "facebook"] as const) {
      expect(metricsProviderFor(p)).toBe("socialcrawl");
      const r = await resolveProvider(p, fakeStore);
      expect(r.provider.providerType).toBe("socialcrawl");
    }
  });

  it("keeps YouTube on the YouTube Data API (never SocialCrawl)", async () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    process.env.NON_YOUTUBE_METRICS_PROVIDER = "socialcrawl";
    process.env.YOUTUBE_API_KEY = "yt_test";
    expect(metricsProviderFor("youtube")).toBe("apify"); // n/a sentinel — never socialcrawl
    const r = await resolveProvider("youtube", fakeStore);
    expect(r.provider.providerType).toBe("youtube_api");
  });

  it("falls back to Apify routing when SocialCrawl is disabled", async () => {
    delete process.env.SOCIALCRAWL_METRICS_ENABLED;
    expect(metricsProviderFor("facebook")).toBe("apify");
  });
});

// ── Fallback behavior ─────────────────────────────────────────────────────────
describe("Apify fallback only when SocialCrawl fails", () => {
  const ok = (videos: number): PlatformFetchResult => ({
    videos: Array.from({ length: videos }, () => ({ platform: "tiktok", originalUrl: "u", externalVideoId: "x", title: null, caption: null, thumbnailUrl: null, publishedAt: null, authorName: null, authorHandle: null, views: 1, likes: null, comments: null, shares: null, saves: null, bookmarks: null, rawJson: null })),
    commentsByVideo: {},
    attempts: [{ provider: "socialcrawl", actorId: null, kind: "metrics", inputDescription: "ok", success: videos > 0, runId: null, itemCount: videos, error: null }],
  });
  const mk = (impl: () => Promise<PlatformFetchResult>): SocialPlatformProvider =>
    ({ platform: "tiktok", providerType: "apify", supportsComments: false, supportsDiscovery: true, supportsSavesOrBookmarks: false, readiness: () => ({ ready: true, status: "live", sourceStatus: "live", detail: null }), discoverNewVideos: async () => [], getVideoMetadata: async () => null, getVideoMetrics: async () => null, getVideoComments: async () => [], fetchPlatform: impl } as SocialPlatformProvider);

  it("does NOT call Apify when SocialCrawl succeeds", async () => {
    const apify = vi.fn(async () => ok(1));
    const primary = mk(async () => ok(2));
    const fb = new FallbackProvider(primary, mk(apify), true);
    const res = await fb.fetchPlatform!(null, [], new Date());
    expect(res.videos).toHaveLength(2);
    expect(apify).not.toHaveBeenCalled();
  });

  it("calls Apify when SocialCrawl throws", async () => {
    const apify = vi.fn(async () => ok(3));
    const primary = mk(async () => { throw new Error("sc down"); });
    const fb = new FallbackProvider(primary, mk(apify), true);
    const res = await fb.fetchPlatform!(null, [], new Date());
    expect(apify).toHaveBeenCalledOnce();
    expect(res.videos).toHaveLength(3);
  });

  it("returns empty (preserve last-known-good) when both fail and never throws", async () => {
    const primary = mk(async () => { throw new Error("sc down"); });
    const fb = new FallbackProvider(primary, mk(async () => { throw new Error("apify down"); }), true);
    const res = await fb.fetchPlatform!(null, [], new Date());
    expect(res.videos).toHaveLength(0); // empty-cycle guard in the pipeline keeps stored values
  });
});

// ── Facebook monotonic protection ─────────────────────────────────────────────
describe("lower Apify viewsCount cannot overwrite higher SocialCrawl plays", () => {
  it("rejects the lower Apify fallback value", () => {
    expect(applyMonotonicViews(54907, 128000)).toEqual({ views: null, rejectedLower: 54907 });
  });
  it("accepts a higher SocialCrawl plays value over a stored low Apify value", () => {
    expect(applyMonotonicViews(128000, 54907)).toEqual({ views: 128000, rejectedLower: null });
  });
});

// ── Schedule: quiet 00:00–07:00 ET, 15-min, 2× comment detail ─────────────────
describe("approved schedule", () => {
  const at = (etHour: number) => new Date(Date.UTC(2026, 5, 16, etHour + 4, 0, 0)); // EDT = UTC-4 (Date.UTC rolls hours>=24 to next day)

  it("quiet hours are 00:00–07:00 ET", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    const cfg = getRefreshPolicyConfig();
    expect(cfg.quietStartHour).toBe(0);
    expect(cfg.quietEndHour).toBe(7);
    expect(isQuietHours(at(6), cfg)).toBe(true); // 6 AM ET — quiet
    expect(isQuietHours(at(7), cfg)).toBe(false); // 7 AM ET — active
    expect(isQuietHours(at(23), cfg)).toBe(false); // 11 PM ET — active
  });

  it("metrics interval defaults to 15 min when SocialCrawl is enabled", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    expect(getRefreshPolicyConfig().fullIntervalMin).toBe(15);
  });

  it("no scheduled refresh during quiet hours", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    const cfg = getRefreshPolicyConfig();
    const d = decideScheduledRefresh({ now: at(3), recentRuns: [], todaysActorRuns: 0, cfg });
    expect(d.action).toBe("skip");
    expect(d).toMatchObject({ kind: "quiet" });
  });

  it("runs every 15 min during active hours", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    const cfg = getRefreshPolicyConfig();
    const runs: RefreshRun[] = [
      { id: "r", startedAt: new Date(at(12).getTime() - 16 * 60_000).toISOString(), finishedAt: null, status: "success", trigger: "cron", platformsAttempted: [], videosUpdated: 0, commentsUpdated: 0, newVideosDiscovered: 0, errors: [], rawLog: ["mode:full discovery:off comments:off"] } as unknown as RefreshRun,
    ];
    const d = decideScheduledRefresh({ now: at(12), recentRuns: runs, todaysActorRuns: 0, cfg });
    expect(d.action).toBe("run"); // 16 min since last full ≥ 15-min interval
  });

  it("comment detail is due twice per active day (12:00 + 18:00 windows)", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    const cfg = getRefreshPolicyConfig();
    expect(cfg.commentDetailWindows).toEqual([12, 18]);
    // before noon: not due
    expect(isCommentDetailDue([], at(10), cfg)).toBe(false);
    // at noon, none yet today: due
    expect(isCommentDetailDue([], at(12), cfg)).toBe(true);
    // after a noon pull, before 18:00: not due again
    const noonPull: RefreshRun[] = [
      { id: "c", startedAt: at(12).toISOString(), finishedAt: at(12).toISOString(), status: "success", trigger: "cron", platformsAttempted: [], videosUpdated: 0, commentsUpdated: 1, newVideosDiscovered: 0, errors: [], rawLog: ["mode:full discovery:off comments:on"] } as unknown as RefreshRun,
    ];
    expect(isCommentDetailDue(noonPull, at(14), cfg)).toBe(false);
    // at 18:00, only the noon pull done: due again (2nd window)
    expect(isCommentDetailDue(noonPull, at(18), cfg)).toBe(true);
  });
});

// ── Daily credit cap ──────────────────────────────────────────────────────────
describe("SocialCrawl daily credit cap", () => {
  const at = (etHour: number) => new Date(Date.UTC(2026, 5, 16, etHour + 4, 0, 0));
  it("stops noncritical refreshes when the credit cap is reached", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    process.env.SOCIALCRAWL_DAILY_CREDIT_CAP = "300";
    const cfg = getRefreshPolicyConfig();
    const d = decideScheduledRefresh({ now: at(12), recentRuns: [], todaysActorRuns: 0, todaysSocialcrawlCredits: 300, cfg });
    expect(d).toMatchObject({ action: "skip", kind: "budget" });
  });
  it("credit counter parses the attempt log (cache hits = call, 0 extra credit handled)", () => {
    const tz = "America/New_York";
    const now = new Date("2026-06-16T16:00:00.000Z");
    const attempts = [
      { provider: "socialcrawl", inputDescription: "socialcrawl tiktok profile · 1cr · cache:miss", capturedAt: "2026-06-16T15:00:00.000Z", success: true },
      { provider: "socialcrawl", inputDescription: "socialcrawl facebook profile · 1cr · cache:hit", capturedAt: "2026-06-16T15:01:00.000Z", success: true },
      { provider: "apify", inputDescription: "x", capturedAt: "2026-06-16T15:02:00.000Z", success: true },
    ];
    const r = socialcrawlCreditsToday(attempts, now, tz);
    expect(r.credits).toBe(2);
    expect(r.calls).toBe(2);
    expect(r.cached).toBe(1);
  });
});

// ── Safety / no secrets ───────────────────────────────────────────────────────
describe("safety — no SocialCrawl key/internals exposed", () => {
  it("provider + config never embed a literal key and read from env only", () => {
    const prov = read("src/lib/providers/socialcrawl-provider.ts");
    const cfg = read("src/lib/config.ts");
    for (const f of [prov, cfg]) {
      expect(f).not.toMatch(/sc_[A-Za-z0-9]{20,}/); // no hardcoded key
      expect(f).not.toContain("NEXT_PUBLIC_SOCIALCRAWL");
    }
    expect(prov).toContain('"x-api-key"');
    expect(prov).toContain("getSocialcrawlKey()");
  });
  it("admin SocialCrawl status exposes no key field", () => {
    const q = read("src/lib/queries.ts");
    const start = q.indexOf("interface SocialcrawlAdminStatus");
    const block = q.slice(start, q.indexOf("}", start));
    // No field that would carry the secret itself (a field name, not a comment).
    expect(block).not.toMatch(/\bapi[_]?key\s*:/i);
    expect(block).not.toMatch(/\bsecret\s*:/i);
    expect(block).not.toMatch(/\btoken\s*:/i);
    expect(block).toContain("configured"); // presence only
  });
  it("the key is never written to a tracked file", () => {
    // .env.local is gitignored; nothing tracked carries the literal.
    expect(read("scripts/socialcrawl-shadow-refresh.ts")).not.toMatch(/sc_[A-Za-z0-9]{20,}/);
  });
});
