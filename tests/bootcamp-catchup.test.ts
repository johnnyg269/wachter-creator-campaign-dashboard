// Bootcamp metrics catch-up: fills ONLY pending Bootcamp videos, cap-bounded,
// SocialCrawl(billable)/YouTube(free), logs spend, never touches excluded/MTL/
// already-refreshed videos, leaves the remainder pending at the cap, never Apify.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootcampMetricsCatchup } from "@/lib/bootcamp-catchup";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import type { NormalizedVideo } from "@/lib/types";
import { useTmpCwd, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const nv = (over: Partial<NormalizedVideo>): NormalizedVideo => ({
  platform: "tiktok", originalUrl: "", externalVideoId: null, title: "t", caption: null, thumbnailUrl: null,
  publishedAt: "2026-05-01T00:00:00.000Z", authorName: null, authorHandle: null,
  views: 1000, likes: 10, comments: 2, shares: 1, saves: null, bookmarks: null, rawJson: null, ...over,
});

describe("bootcampMetricsCatchup", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    process.env.CAMPAIGN_START_DATE_ET = "2024-01-01";
    process.env.BOOTCAMP_START_DATE = "2024-01-01";
  });
  afterEach(async () => {
    reset();
    delete process.env.CAMPAIGN_START_DATE_ET;
    delete process.env.BOOTCAMP_START_DATE;
    await tmp.cleanup();
  });

  // Live-spend probe: counts the catch-up's own logged SocialCrawl credits so the
  // cap gate behaves exactly as in production (where it also includes cron spend).
  const liveUsed = (store: ReturnType<typeof getStore>, base = 0) => async () =>
    base + (await store.listCollectionAttempts(9999)).filter((a) => a.provider === "socialcrawl").length;

  let n = 0;
  const ins = (store: ReturnType<typeof getStore>, cid: string, over: Record<string, unknown>) =>
    store.insertVideo({
      campaignId: cid, platform: "tiktok", profileId: null,
      originalUrl: `https://www.tiktok.com/@x/video/${++n}`, externalVideoId: `e${n}`,
      title: "v", caption: null, thumbnailUrl: null,
      publishedAt: "2026-05-01T00:00:00.000Z", firstTrackedAt: "2026-05-01T00:00:00.000Z",
      lastRefreshedAt: null, status: "active", episodeGroupId: null, sourceStatus: "live",
      errorMessage: null, hidden: false, isSeed: false, rawJson: { campaign: "bootcamp" } as never,
      ...over,
    } as Parameters<typeof store.insertVideo>[0]);

  it("fills a pending Bootcamp video: snapshot + lastRefreshedAt + 1 logged SC credit", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const v = await ins(store, c.id, {});
    const res = await bootcampMetricsCatchup(store, { resolveMetrics: async (_p, url) => nv({ originalUrl: url, views: 5000 }), activeCap: 50, liveUsedToday: liveUsed(store) });
    expect(res.pendingBefore).toBe(1);
    expect(res.filled).toBe(1);
    expect(res.creditsUsed).toBe(1);
    expect((await store.getVideo(v.id))!.lastRefreshedAt).not.toBeNull();
    expect((await store.listSnapshots(v.id))[0].views).toBe(5000);
    const atts = await store.listCollectionAttempts(20);
    expect(atts.some((a) => a.provider === "socialcrawl" && /bootcamp-catchup/.test(a.inputDescription))).toBe(true);
  });

  it("respects the cap headroom — remainder stays pending, capStopped", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await ins(store, c.id, {}); await ins(store, c.id, {}); await ins(store, c.id, {});
    const res = await bootcampMetricsCatchup(store, { resolveMetrics: async (_p, url) => nv({ originalUrl: url }), activeCap: 1, liveUsedToday: liveUsed(store) });
    expect(res.filled).toBe(1);
    expect(res.stillPending).toBe(2);
    expect(res.capStopped).toBe(true);
    expect(res.creditsUsed).toBe(1);
  });

  it("never overspends the live cap: prior/concurrent spend (349) leaves only 1 of 350", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await ins(store, c.id, {}); await ins(store, c.id, {}); await ins(store, c.id, {});
    // Simulate 349 SocialCrawl credits already spent today by other lanes.
    const res = await bootcampMetricsCatchup(store, { resolveMetrics: async (_p, url) => nv({ originalUrl: url }), activeCap: 350, liveUsedToday: liveUsed(store, 349) });
    expect(res.creditsUsed).toBe(1); // 349 + 1 = 350 — never exceeds the cap
    expect(res.filled).toBe(1);
    expect(res.stillPending).toBe(2);
    expect(res.capStopped).toBe(true);
  });

  it("never touches excluded / MTL / already-refreshed videos", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const excluded = await ins(store, c.id, { hidden: true, rawJson: { campaign: "bootcamp", tracking: { status: "excluded", reason: "x" } } as never });
    await ins(store, c.id, { rawJson: { campaign: "mtl" } as never });
    await ins(store, c.id, { lastRefreshedAt: "2026-06-01T00:00:00.000Z" });
    let calls = 0;
    const res = await bootcampMetricsCatchup(store, { resolveMetrics: async () => { calls++; return null; }, activeCap: 50, liveUsedToday: liveUsed(store) });
    expect(res.pendingBefore).toBe(0); // none of the three qualify
    expect(calls).toBe(0);
    expect((await store.getVideo(excluded.id))!.lastRefreshedAt).toBeNull(); // untouched, never refreshed
  });

  it("YouTube is free (fills even at 0 headroom); TikTok is billable", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await ins(store, c.id, { platform: "youtube", originalUrl: "https://www.youtube.com/shorts/abcdefghijk", externalVideoId: "abcdefghijk" });
    const res = await bootcampMetricsCatchup(store, { resolveMetrics: async (_p, url) => nv({ platform: "youtube", originalUrl: url, views: 9 }), activeCap: 0, liveUsedToday: liveUsed(store) });
    expect(res.filled).toBe(1); // YouTube fills even at cap 0 (not billable, not gated)
    expect(res.creditsUsed).toBe(0); // YouTube uses no SocialCrawl credit
  });

  it("null metrics → failed + deadUrls; video stays pending (daily tier retries, no false-dead)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const v = await ins(store, c.id, {});
    const res = await bootcampMetricsCatchup(store, { resolveMetrics: async () => null, activeCap: 50, liveUsedToday: liveUsed(store) });
    expect(res.failed).toBe(1);
    expect(res.filled).toBe(0);
    expect(res.deadUrls.length).toBe(1);
    expect(res.creditsUsed).toBe(1); // the SC call was still made + logged
    expect((await store.getVideo(v.id))!.lastRefreshedAt).toBeNull(); // left pending
  });
});

describe("catch-up safety (source-level)", () => {
  it("the catch-up lib never calls Apify", () => {
    const src = read("src/lib/bootcamp-catchup.ts");
    expect(src).not.toMatch(/apify-provider|ApifyProvider|run-sync|api\.apify\.com/i);
  });
  it("the catch-up route is admin/bearer gated + fail-closed no-Apify (resolveProvider(...,false))", () => {
    const src = read("src/app/api/admin/bootcamp-catchup/route.ts");
    expect(src).toMatch(/isAdminOrCronBearer\(req\)/);
    expect(src).toMatch(/resolveProvider\(platform, store, false\)/);
    expect(src).not.toMatch(/\?secret=/);
  });
});
