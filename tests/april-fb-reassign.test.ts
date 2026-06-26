// April Facebook reassign: the candidate set is exactly the FB reels tagged MTL
// (or untagged→MTL), active, published in [Bootcamp floor, MTL floor). It must
// NOT include epoch-date junk, quarantined/hidden, removed/excluded, June+ MTL,
// already-Bootcamp, or non-Facebook records. Reassign is a pure tag change.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAprilFbBootcampCandidate, listAprilFbCandidates, reassignAprilFbToBootcamp } from "@/lib/april-fb-reassign";
import { campaignTag } from "@/lib/campaigns";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

describe("April FB reassign candidates", () => {
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
      campaignId: cid, platform: "facebook", profileId: null,
      originalUrl: `https://www.facebook.com/reel/${++n}`, externalVideoId: `e${n}`,
      title: "v", caption: null, thumbnailUrl: null,
      publishedAt: "2026-04-20T00:00:00.000Z", firstTrackedAt: "2026-06-26T00:00:00.000Z",
      lastRefreshedAt: "2026-06-26T00:00:00.000Z", status: "active", episodeGroupId: null, sourceStatus: "live",
      errorMessage: null, hidden: false, isSeed: false, rawJson: { campaign: "mtl" } as never,
      ...over,
    } as Parameters<typeof store.insertVideo>[0]);

  it("matches only the April FB MTL/untagged reels; excludes all other classes", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const c1 = await ins(store, c.id, { publishedAt: "2026-04-20T00:00:00.000Z" }); // ✓ MTL April
    const c2 = await ins(store, c.id, { publishedAt: "2026-04-29T00:00:00.000Z" }); // ✓ MTL April
    const c3 = await ins(store, c.id, { rawJson: {}, publishedAt: "2026-04-22T00:00:00.000Z" }); // ✓ untagged→MTL April
    await ins(store, c.id, { publishedAt: "1970-01-21T14:36:56.359Z" }); // ✗ epoch (date_invalid, < bootcamp floor)
    await ins(store, c.id, { hidden: true, publishedAt: "2026-04-23T00:00:00.000Z" }); // ✗ quarantined
    await ins(store, c.id, { rawJson: { campaign: "mtl", tracking: { status: "excluded", reason: "x" } }, hidden: true }); // ✗ excluded
    await ins(store, c.id, { publishedAt: "2026-06-15T00:00:00.000Z" }); // ✗ June MTL (>= MTL floor)
    await ins(store, c.id, { rawJson: { campaign: "bootcamp" }, publishedAt: "2026-04-26T00:00:00.000Z" }); // ✗ already Bootcamp
    await ins(store, c.id, { platform: "tiktok", originalUrl: "https://www.tiktok.com/@x/video/zz", publishedAt: "2026-04-20T00:00:00.000Z" }); // ✗ not FB
    await ins(store, c.id, { publishedAt: "2026-03-01T00:00:00.000Z" }); // ✗ before bootcamp floor (Apr 11)

    const cands = await listAprilFbCandidates(store);
    const ids = cands.map((x) => x.id).sort();
    expect(ids).toEqual([c1.id, c2.id, c3.id].sort());
    expect(cands.every((x) => x.currentCampaign === "mtl")).toBe(true);
  });

  it("reassigns candidates MTL→Bootcamp (pure tag change, snapshots untouched)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const v = await ins(store, c.id, {});
    await store.addSnapshot({ videoId: v.id, capturedAt: "2026-06-26T00:00:00.000Z", views: 430000, likes: 1000, comments: 50, shares: 20, saves: null, bookmarks: null, engagementRate: null, rawJson: null });

    const res = await reassignAprilFbToBootcamp(store);
    expect(res.candidateCount).toBe(1);
    expect(res.reassigned).toHaveLength(1);
    const after = await store.getVideo(v.id);
    expect(campaignTag(after!)).toBe("bootcamp");
    expect(isAprilFbBootcampCandidate(after!)).toBe(false); // no longer a candidate (now Bootcamp)
    // metrics preserved (snapshot untouched)
    expect((await store.listSnapshots(v.id))[0].views).toBe(430000);
    // reversible: assigning back to mtl restores candidacy
  });

  it("onlyIds restricts the write to the confirmed subset", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const a = await ins(store, c.id, {});
    const b = await ins(store, c.id, {});
    const res = await reassignAprilFbToBootcamp(store, { onlyIds: [a.id] });
    expect(res.reassigned.map((r) => r.id)).toEqual([a.id]);
    expect(res.skipped.map((s) => s.id)).toEqual([b.id]);
    expect(campaignTag((await store.getVideo(a.id))!)).toBe("bootcamp");
    expect(campaignTag((await store.getVideo(b.id))!)).toBe("mtl"); // untouched
  });
});
