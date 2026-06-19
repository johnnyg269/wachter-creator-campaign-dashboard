// Immediate thumbnail repair, refresh-cadence grace, refresh-status wording,
// and removal of "Confidence building". Data-stability first; never Apify.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideScheduledRefresh, getRefreshPolicyConfig } from "@/lib/refresh-policy";
import { computeConfidence } from "@/lib/executive";
import { makeVideo } from "./helpers";
import type { RefreshRun } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── Refresh cadence grace (no intermittent skipped tick) ───────────────────────
describe("scheduled refresh runs every tick despite seconds-jitter", () => {
  const ENV = ["SOCIALCRAWL_API_KEY", "SOCIALCRAWL_METRICS_ENABLED", "METRICS_REFRESH_INTERVAL_MINUTES"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    process.env.METRICS_REFRESH_INTERVAL_MINUTES = "15";
  });
  afterEach(() => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });

  const at = (etHour: number, min: number, sec = 0) => new Date(Date.UTC(2026, 5, 18, etHour + 4, min, sec));
  const fullRun = (started: Date): RefreshRun =>
    ({ id: "r", startedAt: started.toISOString(), finishedAt: started.toISOString(), status: "success", trigger: "cron", platformsAttempted: [], videosUpdated: 0, commentsUpdated: 0, newVideosDiscovered: 0, errors: [], rawLog: ["mode:full discovery:off comments:off"] } as unknown as RefreshRun);

  it("a tick 14m57s after the last start still runs (within the 2-min grace)", () => {
    const cfg = getRefreshPolicyConfig();
    expect(cfg.fullIntervalMin).toBe(15);
    // last full started 12:00:06; this cron tick fires 12:15:03 → 14m57s elapsed.
    const d = decideScheduledRefresh({ now: at(12, 15, 3), recentRuns: [fullRun(at(12, 0, 6))], todaysActorRuns: 0, cfg });
    expect(d.action).toBe("run"); // would have been "skip not_due" under the strict >= 15 rule
  });

  it("does NOT run again only ~5m after the last (grace is small, no double-run)", () => {
    const cfg = getRefreshPolicyConfig();
    const d = decideScheduledRefresh({ now: at(12, 5, 0), recentRuns: [fullRun(at(12, 0, 0))], todaysActorRuns: 0, cfg });
    expect(d.action).toBe("skip");
  });
});

// ── Refresh status wording (operational, not vague confidence) ─────────────────
describe("AutoRefreshNote shows next-expected refresh, no vague language", () => {
  const src = read("src/components/ui/auto-refresh-note.tsx");
  it("renders next-refresh / due-now / live wording", () => {
    expect(src).toMatch(/Next refresh in/);
    expect(src).toMatch(/Refresh due now/);
    expect(src).toMatch(/Live tracking active/);
  });
  it("drops the old fixed cadence promise and the confidence headline", () => {
    expect(src).not.toMatch(/Auto-refreshing every/);
    expect(src).not.toMatch(/Confidence building/);
  });
  it("delayed state names the last successful pull", () => {
    expect(src).toMatch(/Last successful pull/);
  });
});

// ── "Confidence building" removed from public / executive copy ─────────────────
describe('"Confidence building" is gone from public + executive copy', () => {
  it("executive.ts no longer emits any confidence headline", () => {
    const src = read("src/lib/executive.ts");
    expect(src).not.toMatch(/Confidence building/);
    expect(src).not.toMatch(/High confidence/);
    // computeConfidence still works (level used internally) with operational copy.
    expect(computeConfidence([]).headline).not.toMatch(/confidence/i);
  });
  it("the dashboard hero no longer renders the confidence headline chip", () => {
    const page = read("src/app/page.tsx");
    expect(page).not.toMatch(/data\.confidence\.headline/);
  });
  it("a building-confidence result uses operational wording", () => {
    const c = computeConfidence([
      // one confirmed, one never-confirmed → "building" level
      ...[100, null].map((v) =>
        ({ video: makeVideo({}), confirmed: { views: v === null ? null : { value: v, at: "2026-06-18T12:00:00.000Z", stale: false, manual: false }, likes: null, comments: null, shares: null } } as never),
      ),
    ]);
    expect(c.level).toBe("building");
    expect(c.headline).toBe("Live tracking active");
  });
});

// ── Immediate thumbnail repair — all platforms, never Apify ────────────────────
const calls = vi.hoisted(() => ({ resolve: [] as Array<{ platform: string; apifyAllowed: unknown }>, meta: [] as string[] }));
vi.mock("@/lib/providers/registry", () => {
  const thumbFor = (platform: string): string | null => {
    if (platform === "facebook") return "https://scontent.xx.fbcdn.net/fb.jpg";
    if (platform === "tiktok") return "https://p16.tiktokcdn-us.com/tt.heic"; // CDN → valid_unverified
    if (platform === "instagram") return "https://scontent.cdninstagram.com/ig.jpg";
    if (platform === "youtube") return "https://i.ytimg.com/vi/x/hq.jpg";
    return null;
  };
  const provider = (platform: string) => ({
    platform,
    providerType: platform === "youtube" ? ("youtube_api" as const) : ("socialcrawl" as const),
    supportsComments: false,
    supportsDiscovery: true,
    readiness: () => ({ ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null }),
    fetchPlatform: async () => ({ videos: [], commentsByVideo: {}, attempts: [] }),
    getVideoMetadata: async (url: string) => {
      calls.meta.push(url);
      return { platform, originalUrl: url, externalVideoId: null, title: null, caption: null, thumbnailUrl: thumbFor(platform), publishedAt: null, authorName: null, authorHandle: null, views: null, likes: null, comments: null, shares: null, saves: null, bookmarks: null, rawJson: null };
    },
    getVideoMetrics: async () => null,
    getVideoComments: async () => [],
    discoverNewVideos: async () => [],
  });
  return {
    resolveProvider: async (platform: string, _store: unknown, apifyAllowed?: unknown) => {
      calls.resolve.push({ platform, apifyAllowed });
      return { provider: provider(platform), readiness: provider(platform).readiness(), config: null };
    },
    resolveAllProviders: async () => ({}),
  };
});

import { repairMissingThumbnails } from "@/lib/thumbnail-repair";
import { readThumbState } from "@/lib/thumbnail-state";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, type TmpCwd } from "./helpers";

describe("repairMissingThumbnails (immediate, server-side)", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => { tmp = await useTmpCwd(); reset(); calls.resolve = []; calls.meta = []; process.env.CAMPAIGN_START_DATE_ET = "2026-06-08"; });
  afterEach(async () => { reset(); delete process.env.CAMPAIGN_START_DATE_ET; await tmp.cleanup(); });

  const insertMissing = async (platform: string, n: number) => {
    const store = getStore();
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = await store.insertVideo({
        campaignId: "c", platform: platform as never, profileId: null,
        originalUrl: `https://www.${platform}.com/x/${platform}-${i}`, externalVideoId: `${platform}-${i}`,
        title: `${platform} ${i}`, caption: null, thumbnailUrl: null,
        publishedAt: "2026-06-12T00:00:00.000Z", firstTrackedAt: "2026-06-12T00:00:00.000Z",
        lastRefreshedAt: "2026-06-12T00:00:00.000Z", status: "active", episodeGroupId: null,
        sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false, rawJson: null,
      });
      ids.push(v.id);
    }
    return ids;
  };

  it("repairs ALL active missing Facebook covers (6 > old 5-per-cycle cap)", async () => {
    const store = getStore();
    await ensureSeedData(store);
    const fbIds = await insertMissing("facebook", 6);
    const res = await repairMissingThumbnails(store);
    // Every one of the 6 FB videos now has a cover.
    for (const id of fbIds) expect((await store.getVideo(id))?.thumbnailUrl).toBe("https://scontent.xx.fbcdn.net/fb.jpg");
    // ≥6 (a seed FB video may also have been missing) — the point is all 6 of
    // ours are repaired, never capped at an arbitrary 5.
    expect(res.byPlatform.facebook.repaired).toBeGreaterThanOrEqual(6);
    expect(res.failures.filter((f) => f.platform === "facebook")).toHaveLength(0);
  });

  it("NEVER calls Apify — resolveProvider is always invoked with apifyAllowed=false", async () => {
    const store = getStore();
    await ensureSeedData(store);
    await insertMissing("facebook", 2);
    calls.resolve = []; // isolate the repair's resolveProvider calls from seeding
    await repairMissingThumbnails(store);
    expect(calls.resolve.length).toBeGreaterThan(0);
    // The repair always disables Apify explicitly (apifyAllowed=false), and
    // never allows it (=== true) under any path.
    expect(calls.resolve.every((c) => c.apifyAllowed === false)).toBe(true);
    expect(calls.resolve.some((c) => c.apifyAllowed === true)).toBe(false);
  });

  it("stores a TikTok cover as valid_unverified (CDN can't be server-verified)", async () => {
    const store = getStore();
    await ensureSeedData(store);
    const [ttId] = await insertMissing("tiktok", 1);
    await repairMissingThumbnails(store);
    const v = await store.getVideo(ttId);
    expect(v?.thumbnailUrl).toBe("https://p16.tiktokcdn-us.com/tt.heic");
    expect(readThumbState(v?.rawJson).status).toBe("valid_unverified");
  });

  it("does NOT overwrite a good existing thumbnail", async () => {
    const store = getStore();
    await ensureSeedData(store);
    const good = await store.insertVideo({
      campaignId: "c", platform: "facebook", profileId: null,
      originalUrl: "https://www.facebook.com/reel/keepme", externalVideoId: "keepme",
      title: "keep", caption: null, thumbnailUrl: "https://scontent.xx.fbcdn.net/ALREADY-GOOD.jpg",
      publishedAt: "2026-06-12T00:00:00.000Z", firstTrackedAt: "2026-06-12T00:00:00.000Z",
      lastRefreshedAt: "2026-06-12T00:00:00.000Z", status: "active", episodeGroupId: null,
      sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false, rawJson: null,
    });
    await repairMissingThumbnails(store);
    expect((await store.getVideo(good.id))?.thumbnailUrl).toBe("https://scontent.xx.fbcdn.net/ALREADY-GOOD.jpg");
    // It was never even looked up (not missing).
    expect(calls.meta).not.toContain("https://www.facebook.com/reel/keepme");
  });

  it("skips exhausted (status=failed) covers without spending a credit", async () => {
    const store = getStore();
    await ensureSeedData(store);
    await store.insertVideo({
      campaignId: "c", platform: "facebook", profileId: null,
      originalUrl: "https://www.facebook.com/reel/exhausted", externalVideoId: "exhausted",
      title: "exhausted", caption: null, thumbnailUrl: null,
      publishedAt: "2026-06-12T00:00:00.000Z", firstTrackedAt: "2026-06-12T00:00:00.000Z",
      lastRefreshedAt: "2026-06-12T00:00:00.000Z", status: "active", episodeGroupId: null,
      sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false,
      rawJson: { thumb: { status: "failed", attempts: 3, lastAttemptAt: null, nextRetryAt: null, failureReason: "x", resolvedFrom: null } } as never,
    });
    const res = await repairMissingThumbnails(store);
    // Never looked up (no credit spent), and reported with the max-retries reason.
    expect(calls.meta).not.toContain("https://www.facebook.com/reel/exhausted");
    expect(res.failures.some((f) => f.slug.includes("exhausted") && /max retries/.test(f.reason))).toBe(true);
  });

  it("does not touch hidden / excluded videos", async () => {
    const store = getStore();
    await ensureSeedData(store);
    const hidden = await store.insertVideo({
      campaignId: "c", platform: "facebook", profileId: null,
      originalUrl: "https://www.facebook.com/reel/hidden", externalVideoId: "hidden",
      title: "hidden", caption: null, thumbnailUrl: null,
      publishedAt: "2026-06-12T00:00:00.000Z", firstTrackedAt: "2026-06-12T00:00:00.000Z",
      lastRefreshedAt: null, status: "active", episodeGroupId: null,
      sourceStatus: "live", errorMessage: null, hidden: true, isSeed: false, rawJson: null,
    });
    await repairMissingThumbnails(store);
    expect((await store.getVideo(hidden.id))?.thumbnailUrl).toBeNull();
    expect(calls.meta).not.toContain("https://www.facebook.com/reel/hidden");
  });
});

// ── Repair route auth (admin OR cron secret), never public ─────────────────────
describe("repair-thumbnails route is gated", () => {
  const src = read("src/app/api/admin/repair-thumbnails/route.ts");
  it("requires an admin session or the CRON_SECRET bearer (header-only, fail-closed)", () => {
    expect(src).toMatch(/checkAdminRequest/);
    expect(src).toMatch(/bearerMatches/);
    expect(src).toMatch(/401/);
    // No query-param secret (would leak into logs); fail-closed when unconfigured.
    expect(src).not.toMatch(/searchParams\.get\("secret"\)/);
    expect(src).toMatch(/!getAdminPassword\(\) && !getCronSecret\(\)/);
  });
  it("the shared cron route is also header-only (no ?secret= leak)", () => {
    expect(read("src/app/api/cron/refresh/route.ts")).not.toMatch(/searchParams\.get\("secret"\)/);
    expect(read("src/app/api/cron/refresh/route.ts")).toMatch(/bearerMatches/);
  });
  it("never constructs or imports Apify (uses resolveProvider with apifyAllowed=false)", () => {
    const src = read("src/lib/thumbnail-repair.ts");
    expect(src).not.toMatch(/apify-provider/); // no ApifyProvider import
    expect(src).not.toMatch(/new ApifyProvider/);
    expect(src).toMatch(/resolveProvider\(p, store, false\)/);
  });
});
