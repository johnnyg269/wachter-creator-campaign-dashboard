// Bootcamp backfill APPROVE → WRITE (Phase 2B-final): the import writes records
// only for selected candidates, with manual assignment as the source of truth
// (already-MTL never overwritten, excluded never re-added, no duplicates), the
// correct campaign tag + Option-B tier, cap-bounded initial metrics (rest
// pending), and NEVER Apify. Integration with the real JsonStore + an injected
// metrics resolver; campaign scoping verified through loadCampaignData.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importBackfillCandidates, parseImportCandidates, type ImportCandidate, type MetricsResolver } from "@/lib/backfill-import";
import { loadCampaignData } from "@/lib/queries";
import { videoRefreshTier } from "@/lib/refresh-tiers";
import { videoCampaign, isAdminExcluded } from "@/lib/campaigns";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import type { NormalizedVideo, Platform } from "@/lib/types";
import { useTmpCwd, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

const nv = (over: Partial<NormalizedVideo>): NormalizedVideo => ({
  platform: "tiktok", originalUrl: "", externalVideoId: null, title: "t", caption: null,
  thumbnailUrl: "https://img/x.jpg", publishedAt: null, authorName: null, authorHandle: null,
  views: 1234, likes: 10, comments: 2, shares: 1, saves: null, bookmarks: null, rawJson: null, ...over,
});

// Resolver that returns metrics for any URL (1 "credit" per SC platform).
const resolver: MetricsResolver = async (_platform, url) => nv({ originalUrl: url, views: 5000 });
const nullResolver: MetricsResolver = async () => null;

const cand = (over: Partial<ImportCandidate>): ImportCandidate => ({
  platform: "tiktok",
  url: `https://www.tiktok.com/@cybernick0x/video/${Math.round(Math.random() * 1e9)}`,
  externalVideoId: null, publishedAt: ago(30), title: "v", caption: null, thumbnailUrl: null,
  assignment: "bootcamp", ...over,
});

describe("parseImportCandidates", () => {
  it("keeps only valid platform + url + assignment", () => {
    const out = parseImportCandidates([
      { platform: "tiktok", url: "https://x", assignment: "bootcamp" },
      { platform: "nope", url: "https://x", assignment: "bootcamp" },
      { platform: "tiktok", url: "", assignment: "bootcamp" },
      { platform: "tiktok", url: "https://x", assignment: "weird" },
    ]);
    expect(out).toHaveLength(1);
  });
});

describe("importBackfillCandidates", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    // Low floors so April/older test videos are eligible; tier comes from age.
    process.env.CAMPAIGN_START_DATE_ET = "2024-01-01";
    process.env.BOOTCAMP_START_DATE = "2024-01-01";
  });
  afterEach(async () => {
    reset();
    delete process.env.CAMPAIGN_START_DATE_ET;
    delete process.env.BOOTCAMP_START_DATE;
    await tmp.cleanup();
  });

  it("creates a Bootcamp record (daily tier), counts in Bootcamp + All, NOT in MTL", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const url = "https://www.tiktok.com/@cybernick0x/video/700";
    const res = await importBackfillCandidates(store, c.id, [cand({ url, externalVideoId: "700", publishedAt: ago(70), assignment: "bootcamp" })], { resolveMetrics: resolver, scHeadroom: 50 });
    expect(res.created).toBe(1);
    expect(res.assignedBootcamp).toBe(1);
    expect(res.creditsUsed).toBe(1); // one SC initial-metrics fetch

    const v = (await store.listVideos({ includeHidden: true })).find((x) => x.externalVideoId === "700")!;
    expect(videoCampaign(v)).toBe("bootcamp");
    expect(videoRefreshTier(v)).toBe("bootcamp_daily"); // daily, never 15/30
    expect((await store.listSnapshots(v.id))[0].views).toBe(5000); // initial metrics stored

    const boot = await loadCampaignData(false, "bootcamp");
    const mtl = await loadCampaignData(false, "mtl");
    const all = await loadCampaignData(false, "all");
    expect(boot.videos.some((x) => x.id === v.id)).toBe(true);
    expect(mtl.videos.some((x) => x.id === v.id)).toBe(false);
    expect(all.videos.some((x) => x.id === v.id)).toBe(true);
  });

  it("creates an MTL record with hot/warm tier by age", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await importBackfillCandidates(store, c.id, [
      cand({ url: "https://www.tiktok.com/@x/video/hot1", externalVideoId: "hot1", publishedAt: ago(2), assignment: "mtl" }),
      cand({ url: "https://www.tiktok.com/@x/video/warm1", externalVideoId: "warm1", publishedAt: ago(20), assignment: "mtl" }),
    ], { resolveMetrics: resolver, scHeadroom: 50 });
    const all = await store.listVideos({ includeHidden: true });
    expect(videoRefreshTier(all.find((x) => x.externalVideoId === "hot1")!)).toBe("mtl_hot");
    expect(videoRefreshTier(all.find((x) => x.externalVideoId === "warm1")!)).toBe("mtl_warm");
    const mtl = await loadCampaignData(false, "mtl");
    expect(mtl.videos.filter((x) => x.externalVideoId === "hot1" || x.externalVideoId === "warm1")).toHaveLength(2);
  });

  it("does NOT overwrite an already-MTL video when assignment=mtl (skip, no dup)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const url = "https://www.tiktok.com/@x/video/800";
    await store.insertVideo({ campaignId: c.id, platform: "tiktok", profileId: null, originalUrl: url, externalVideoId: "800", title: "existing", caption: null, thumbnailUrl: null, publishedAt: ago(3), firstTrackedAt: ago(3), lastRefreshedAt: ago(1), status: "active", episodeGroupId: null, sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false, rawJson: { campaign: "mtl" } as never });
    const before = (await store.listVideos({ includeHidden: true })).length;
    const res = await importBackfillCandidates(store, c.id, [cand({ url, externalVideoId: "800", assignment: "mtl" })], { resolveMetrics: resolver, scHeadroom: 50 });
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.skippedReasons.already_assigned).toBe(1);
    expect((await store.listVideos({ includeHidden: true })).length).toBe(before); // no duplicate
  });

  it("EXPLICIT reassignment of an already-MTL video to Bootcamp (admin chose it) updates the tag only", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const url = "https://www.tiktok.com/@x/video/810";
    const ex = await store.insertVideo({ campaignId: c.id, platform: "tiktok", profileId: null, originalUrl: url, externalVideoId: "810", title: "ex", caption: null, thumbnailUrl: null, publishedAt: ago(3), firstTrackedAt: ago(3), lastRefreshedAt: ago(1), status: "active", episodeGroupId: null, sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false, rawJson: { campaign: "mtl" } as never });
    const res = await importBackfillCandidates(store, c.id, [cand({ url, externalVideoId: "810", assignment: "bootcamp" })], { resolveMetrics: resolver, scHeadroom: 50 });
    expect(res.updated).toBe(1);
    expect(res.created).toBe(0);
    expect(videoCampaign((await store.getVideo(ex.id))!)).toBe("bootcamp");
  });

  it("never re-adds an excluded video", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const url = "https://www.tiktok.com/@x/video/820";
    await store.insertVideo({ campaignId: c.id, platform: "tiktok", profileId: null, originalUrl: url, externalVideoId: "820", title: "x", caption: null, thumbnailUrl: null, publishedAt: ago(3), firstTrackedAt: ago(3), lastRefreshedAt: null, status: "active", episodeGroupId: null, sourceStatus: "live", errorMessage: null, hidden: true, isSeed: false, rawJson: { tracking: { status: "excluded", reason: "off" } } as never });
    const before = (await store.listVideos({ includeHidden: true })).length;
    const res = await importBackfillCandidates(store, c.id, [cand({ url, externalVideoId: "820", assignment: "bootcamp" })], { resolveMetrics: resolver, scHeadroom: 50 });
    expect(res.skippedReasons.already_excluded).toBe(1);
    expect(res.created).toBe(0);
    expect((await store.listVideos({ includeHidden: true })).length).toBe(before);
  });

  it("unassigned import is created but does NOT count publicly", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const res = await importBackfillCandidates(store, c.id, [cand({ url: "https://www.tiktok.com/@x/video/830", externalVideoId: "830", assignment: "unassigned" })], { resolveMetrics: resolver, scHeadroom: 50 });
    expect(res.assignedUnassigned).toBe(1);
    expect(res.creditsUsed).toBe(0); // unassigned doesn't fetch metrics
    const all = await loadCampaignData(false, "all");
    expect(all.videos.some((x) => x.externalVideoId === "830")).toBe(false); // not public
  });

  it("respects the SocialCrawl cap headroom — beyond it, metrics are PENDING (no overspend)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const cands = [1, 2, 3].map((n) => cand({ url: `https://www.tiktok.com/@x/video/c${n}`, externalVideoId: `c${n}`, assignment: "bootcamp" }));
    const res = await importBackfillCandidates(store, c.id, cands, { resolveMetrics: resolver, scHeadroom: 1 });
    expect(res.created).toBe(3);
    expect(res.creditsUsed).toBe(1); // only ONE initial-metrics fetch fit the headroom
    expect(res.pendingMetrics).toBe(2); // the rest pending (daily tier fetches them)
  });

  it("logs a SocialCrawl collection attempt per billable resolve (so the cap sees this lane's spend)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await importBackfillCandidates(store, c.id, [
      cand({ url: "https://www.tiktok.com/@x/video/sc1", externalVideoId: "sc1", assignment: "bootcamp" }),
      cand({ platform: "youtube", url: "https://www.youtube.com/shorts/yt1aaaaaaa", externalVideoId: "yt1aaaaaaa", assignment: "bootcamp" }),
    ], { resolveMetrics: resolver, scHeadroom: 50 });
    const atts = await store.listCollectionAttempts(50);
    const scLogged = atts.filter((a) => a.provider === "socialcrawl" && /backfill-import/.test(a.inputDescription));
    expect(scLogged.length).toBe(1); // TikTok billable; YouTube is free (not logged)
    expect(scLogged[0].inputDescription).toMatch(/1cr/);
  });

  it("a campaign candidate with NO usable date is skipped (not silently created + dropped from totals)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const res = await importBackfillCandidates(store, c.id, [
      cand({ url: "https://www.tiktok.com/@x/video/nd1", externalVideoId: "nd1", publishedAt: null, assignment: "bootcamp" }),
    ], { resolveMetrics: nullResolver, scHeadroom: 50 }); // resolver returns no date either
    expect(res.created).toBe(0);
    expect(res.skippedReasons.date_missing).toBe(1);
    expect((await store.listVideos({ includeHidden: true })).some((v) => v.externalVideoId === "nd1")).toBe(false);
  });

  it("creates records even when the resolver returns nothing (metrics pending, no crash)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const res = await importBackfillCandidates(store, c.id, [cand({ url: "https://www.tiktok.com/@x/video/900", externalVideoId: "900", assignment: "bootcamp" })], { resolveMetrics: nullResolver, scHeadroom: 50 });
    expect(res.created).toBe(1);
    expect(res.pendingMetrics).toBe(1);
    const v = (await store.listVideos({ includeHidden: true })).find((x) => x.externalVideoId === "900")!;
    expect(v.lastRefreshedAt).toBeNull(); // pending → daily tier picks it up
  });
});

describe("backfill import safety (source-level)", () => {
  it("the import module never CALLS Apify (initial metrics use the injected ongoing resolver)", () => {
    const src = read("src/lib/backfill-import.ts");
    // No Apify client/actor/run usage (the word may appear only in comments;
    // actorId:null is a generic CollectionAttempt field, not Apify usage).
    expect(src).not.toMatch(/apify-provider|ApifyProvider|run-sync|api\.apify\.com|enumerateApify/);
  });
  it("the import route is admin/bearer gated, supports preview + confirm, never Apify", () => {
    const src = read("src/app/api/admin/bootcamp-backfill/import/route.ts");
    expect(src).toMatch(/isAdminOrCronBearer\(req\)/);
    expect(src).toMatch(/preview === true/);
    expect(src).toMatch(/confirm !== true/);
    expect(src).not.toMatch(/run-sync|enumerateApify/);
  });
  it("initial-metrics resolver is fail-closed no-Apify (resolveProvider(..., false))", () => {
    const src = read("src/app/api/admin/bootcamp-backfill/import/route.ts");
    expect(src).toMatch(/resolveProvider\(platform, store, false\)/);
  });
});
