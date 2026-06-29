// Restore stranded Bootcamp: the candidate set is exactly the videos tagged MTL
// (or untagged→MTL), active, published in [Bootcamp floor, MTL floor) — across ALL
// platforms. It must NOT include epoch-date junk, quarantined/hidden, removed/
// excluded, June+ MTL, already-Bootcamp. Reassign is a pure tag change.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStrandedBootcampCandidate, listStrandedBootcampCandidates, restoreStrandedBootcampTags } from "@/lib/restore-bootcamp-tags";
import { campaignTag } from "@/lib/campaigns";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

describe("restore stranded Bootcamp tags", () => {
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
      originalUrl: `https://x/${++n}`, externalVideoId: `e${n}`,
      title: "v", caption: null, thumbnailUrl: null,
      publishedAt: "2026-04-20T00:00:00.000Z", firstTrackedAt: "2026-06-29T00:00:00.000Z",
      lastRefreshedAt: "2026-06-29T00:00:00.000Z", status: "active", episodeGroupId: null, sourceStatus: "live",
      errorMessage: null, hidden: false, isSeed: false, rawJson: { campaign: "mtl" } as never,
      ...over,
    } as Parameters<typeof store.insertVideo>[0]);

  it("matches stranded Bootcamp across ALL platforms; excludes every other class", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const wanted = [
      await ins(store, c.id, { platform: "tiktok", publishedAt: "2026-04-20T00:00:00.000Z" }),
      await ins(store, c.id, { platform: "youtube", publishedAt: "2026-04-13T00:00:00.000Z" }),
      await ins(store, c.id, { platform: "instagram", publishedAt: "2026-05-18T00:00:00.000Z" }),
      await ins(store, c.id, { platform: "facebook", publishedAt: "2026-04-29T00:00:00.000Z" }),
      await ins(store, c.id, { rawJson: {}, publishedAt: "2026-04-22T00:00:00.000Z" }), // untagged→mtl
    ];
    await ins(store, c.id, { publishedAt: "1970-01-21T14:36:56.359Z" }); // epoch junk
    await ins(store, c.id, { hidden: true, publishedAt: "2026-04-23T00:00:00.000Z" }); // quarantined
    await ins(store, c.id, { rawJson: { campaign: "mtl", tracking: { status: "excluded", reason: "x" } }, hidden: true }); // removed
    await ins(store, c.id, { publishedAt: "2026-06-15T00:00:00.000Z" }); // June MTL (>= floor)
    await ins(store, c.id, { rawJson: { campaign: "bootcamp" }, publishedAt: "2026-04-26T00:00:00.000Z" }); // already bootcamp
    await ins(store, c.id, { publishedAt: "2026-03-01T00:00:00.000Z" }); // before bootcamp floor

    const cands = await listStrandedBootcampCandidates(store);
    expect(cands.map((x) => x.id).sort()).toEqual(wanted.map((x) => x.id).sort());
  });

  it("reassigns to Bootcamp (pure tag change, snapshots untouched, reversible)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const v = await ins(store, c.id, { platform: "youtube" });
    await store.addSnapshot({ videoId: v.id, capturedAt: "2026-06-29T00:00:00.000Z", views: 50000, likes: 100, comments: 5, shares: 1, saves: null, bookmarks: null, engagementRate: null, rawJson: null });
    const res = await restoreStrandedBootcampTags(store);
    expect(res.candidateCount).toBe(1);
    expect(res.reassigned).toHaveLength(1);
    expect(campaignTag((await store.getVideo(v.id))!)).toBe("bootcamp");
    expect(isStrandedBootcampCandidate((await store.getVideo(v.id))!)).toBe(false); // now bootcamp, not a candidate
    expect((await store.listSnapshots(v.id))[0].views).toBe(50000); // metrics intact
  });

  it("onlyIds restricts the write to the confirmed subset", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const a = await ins(store, c.id, {});
    const b = await ins(store, c.id, {});
    const res = await restoreStrandedBootcampTags(store, { onlyIds: [a.id] });
    expect(res.reassigned.map((r) => r.id)).toEqual([a.id]);
    expect(campaignTag((await store.getVideo(a.id))!)).toBe("bootcamp");
    expect(campaignTag((await store.getVideo(b.id))!)).toBe("mtl");
  });
});
