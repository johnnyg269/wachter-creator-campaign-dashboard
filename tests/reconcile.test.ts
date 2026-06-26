// Campaign reconciliation: active totals mirror loadCampaignData (the dashboard
// chokepoint), the raw-record breakdown explains the active-vs-total gap by
// reason, and the cross-campaign invariants (all == bootcamp + mtl, no overlap,
// no excluded/unassigned in active) always hold. Deltas-from-baseline keep the
// assertions robust against seed videos.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcileCampaigns } from "@/lib/reconcile";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

describe("reconcileCampaigns", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE"]);
    process.env.CAMPAIGN_START_DATE_ET = "2026-06-01";
    process.env.BOOTCAMP_START_DATE = "2026-04-11";
  });
  afterEach(async () => {
    reset();
    restore();
    await tmp.cleanup();
  });

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

  const snap = (store: ReturnType<typeof getStore>, videoId: string, views: number) =>
    store.addSnapshot({
      videoId, capturedAt: "2026-06-20T00:00:00.000Z", views, likes: 1, comments: 1, shares: 1,
      saves: null, bookmarks: null, engagementRate: null, rawJson: null,
    });

  it("active totals mirror the dashboard and the all == bootcamp + mtl invariants hold", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const base = await reconcileCampaigns(store);

    const b1 = await ins(store, c.id, {}); await snap(store, b1.id, 1000);
    const b2 = await ins(store, c.id, {}); await snap(store, b2.id, 2000);
    const m1 = await ins(store, c.id, { rawJson: { campaign: "mtl" }, publishedAt: "2026-06-15T00:00:00.000Z" }); await snap(store, m1.id, 500);

    const r = await reconcileCampaigns(store);
    expect(r.bootcamp.activePublicCount - base.bootcamp.activePublicCount).toBe(2);
    expect((r.bootcamp.activeTotalViews ?? 0) - (base.bootcamp.activeTotalViews ?? 0)).toBe(3000);
    expect(r.mtl.activePublicCount - base.mtl.activePublicCount).toBe(1);
    expect((r.mtl.activeTotalViews ?? 0) - (base.mtl.activeTotalViews ?? 0)).toBe(500);

    // Invariants — these must always hold.
    expect(r.invariants.allViewsEqualsBootcampPlusMtl).toBe(true);
    expect(r.invariants.allCountEqualsBootcampPlusMtl).toBe(true);
    expect(r.invariants.noVideoInTwoCampaigns).toBe(true);
    expect(r.invariants.noExcludedInActive).toBe(true);
    expect(r.invariants.noUnassignedInActive).toBe(true);
    expect(r.invariants.noMtlRecordInBootcampActive).toBe(true);
    expect(r.allActivePublicCount).toBe(r.bootcamp.activePublicCount + r.mtl.activePublicCount);
  });

  it("explains the active-vs-total gap: excluded, before-start, and missing-metrics", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const base = await reconcileCampaigns(store);

    await ins(store, c.id, {}); // active, but no snapshot → counts in count, 0 views, pending
    const withViews = await ins(store, c.id, {}); await snap(store, withViews.id, 9000);
    await ins(store, c.id, { hidden: true, rawJson: { campaign: "bootcamp", tracking: { status: "excluded", reason: "x" } } }); // excluded
    await ins(store, c.id, { publishedAt: "2026-03-01T00:00:00.000Z" }); // before April floor → before_campaign_start
    await ins(store, c.id, { rawJson: { campaign: "unassigned" } }); // unassigned, admin-only

    const r = await reconcileCampaigns(store);
    // 5 new bootcamp-tagged records (active+pending, active+views, excluded, before-start) — unassigned is NOT bootcamp-tagged.
    expect(r.bootcamp.totalRecords - base.bootcamp.totalRecords).toBe(4);
    expect(r.bootcamp.activePublicCount - base.bootcamp.activePublicCount).toBe(2); // the two eligible/active
    expect(r.bootcamp.activeMissingMetricsCount - base.bootcamp.activeMissingMetricsCount).toBe(1);
    expect(r.bootcamp.excludedCount - base.bootcamp.excludedCount).toBe(1);
    expect(r.bootcamp.droppedFromActive - base.bootcamp.droppedFromActive).toBe(2);
    expect(r.bootcamp.dropReasons.excluded).toBeGreaterThanOrEqual(1);
    expect(r.bootcamp.dropReasons.before_campaign_start).toBeGreaterThanOrEqual(1);
    expect(r.unassignedAdminOnlyCount - base.unassignedAdminOnlyCount).toBe(1);
    expect(r.excludedGlobalCount - base.excludedGlobalCount).toBe(1);
    expect(r.pendingMetricsTotal - base.pendingMetricsTotal).toBe(1);

    // dropReasons must account for exactly the dropped records.
    const dropped = Object.values(r.bootcamp.dropReasons).reduce((a, b) => a + b, 0);
    expect(dropped).toBe(r.bootcamp.droppedFromActive);
    // Invariants still hold with excluded/unassigned/ineligible present.
    expect(r.invariants.allViewsEqualsBootcampPlusMtl).toBe(true);
    expect(r.invariants.noExcludedInActive).toBe(true);
    expect(r.invariants.noUnassignedInActive).toBe(true);
  });
});
