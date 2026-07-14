// YouTube Shorts catch-up: free Data API lane — dedups tracked videos, never
// re-adds excluded/removed, inserts missing Shorts with REAL API metrics + an
// explicit MTL tag, verifies a specific URL, and never touches SocialCrawl.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { youtubeShortsCatchup } from "@/lib/youtube-catchup";
import { campaignTag } from "@/lib/campaigns";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import type { NormalizedVideo } from "@/lib/types";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

const up = (id: string, views: number, publishedAt: string): NormalizedVideo => ({
  platform: "youtube", originalUrl: `https://www.youtube.com/shorts/${id}`, externalVideoId: id,
  title: `short ${id}`, caption: null, thumbnailUrl: null, publishedAt,
  authorName: null, authorHandle: null, views, likes: 10, comments: 2, shares: null,
  saves: null, bookmarks: null, rawJson: null,
});

const fakeProvider = (uploads: NormalizedVideo[]) => ({
  readiness: () => ({ ready: true, status: "live", sourceStatus: "live", detail: null }) as never,
  listRecentUploads: async () => uploads,
  getVideoComments: async () => [],
});

describe("youtubeShortsCatchup", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE"]);
    process.env.CAMPAIGN_START_DATE_ET = "2024-01-01";
    process.env.BOOTCAMP_START_DATE = "2024-01-01";
  });
  afterEach(async () => {
    reset();
    restore();
    await tmp.cleanup();
  });

  it("inserts missing Shorts (real metrics, explicit MTL tag); dedups tracked; skips excluded; verifies checkUrl", async () => {
    const store = getStore();
    const c = await ensureSeedData(store); // seeds the 4 platform profiles incl. YouTube
    // Already tracked short:
    await store.insertVideo({
      campaignId: c.id, platform: "youtube", profileId: null,
      originalUrl: "https://www.youtube.com/shorts/TRACKED01", externalVideoId: "TRACKED01",
      title: "t", caption: null, thumbnailUrl: null, publishedAt: "2026-07-01T00:00:00.000Z",
      firstTrackedAt: "2026-07-01T00:00:00.000Z", lastRefreshedAt: null, status: "active",
      episodeGroupId: null, sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false,
      rawJson: { campaign: "mtl" } as never,
    } as Parameters<typeof store.insertVideo>[0]);
    // Excluded short (must NOT be re-added / un-hidden):
    await store.insertVideo({
      campaignId: c.id, platform: "youtube", profileId: null,
      originalUrl: "https://www.youtube.com/shorts/EXCLUDED1", externalVideoId: "EXCLUDED1",
      title: "x", caption: null, thumbnailUrl: null, publishedAt: "2026-07-02T00:00:00.000Z",
      firstTrackedAt: "2026-07-02T00:00:00.000Z", lastRefreshedAt: null, status: "active",
      episodeGroupId: null, sourceStatus: "live", errorMessage: null, hidden: true, isSeed: false,
      rawJson: { campaign: "mtl", tracking: { status: "excluded", reason: "test" } } as never,
    } as Parameters<typeof store.insertVideo>[0]);

    const uploads = [
      up("TRACKED01", 100, "2026-07-01T00:00:00.000Z"),
      up("EXCLUDED1", 200, "2026-07-02T00:00:00.000Z"),
      up("JLODDXZA0HM", 5400, "2026-07-10T00:00:00.000Z"), // the missing one
    ];
    const res = await youtubeShortsCatchup(store, {
      insert: true,
      checkUrl: "https://www.youtube.com/shorts/JLODDXZA0HM",
      providerOverride: fakeProvider(uploads) as never,
      now: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(res.apiFound).toBe(3);
    expect(res.alreadyTracked).toBe(1);
    expect(res.excludedSkipped).toBe(1); // removed stays removed
    expect(res.inserted).toHaveLength(1);
    expect(res.inserted[0].url).toContain("JLODDXZA0HM");
    expect(res.urlCheck).toMatchObject({ insertedNow: true, excluded: false });
    // Inserted with the explicit MTL tag + REAL API metrics as the first snapshot.
    const inserted = await store.findVideoByUrlOrExternalId("youtube", "https://www.youtube.com/shorts/JLODDXZA0HM", "JLODDXZA0HM");
    expect(inserted).not.toBeNull();
    expect(campaignTag(inserted!)).toBe("mtl");
    const snaps = await store.listSnapshots(inserted!.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].views).toBe(5400);
    // Excluded video still hidden/excluded:
    const ex = await store.findVideoByUrlOrExternalId("youtube", "https://www.youtube.com/shorts/EXCLUDED1", "EXCLUDED1");
    expect(ex!.hidden).toBe(true);
  });

  it("dry-run (no confirm) writes nothing; re-run after insert reports alreadyTracked (no duplicates)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store); // seeds the YouTube profile
    void c;
    const uploads = [up("NEWSHORT1", 900, "2026-07-12T00:00:00.000Z")];
    const dry = await youtubeShortsCatchup(store, { providerOverride: fakeProvider(uploads) as never, now: new Date("2026-07-14T12:00:00.000Z") });
    expect(dry.inserted).toHaveLength(0);
    expect(dry.apiFound).toBe(1);
    const run1 = await youtubeShortsCatchup(store, { insert: true, providerOverride: fakeProvider(uploads) as never, now: new Date("2026-07-14T12:00:00.000Z") });
    expect(run1.inserted).toHaveLength(1);
    const run2 = await youtubeShortsCatchup(store, { insert: true, providerOverride: fakeProvider(uploads) as never, now: new Date("2026-07-14T12:05:00.000Z") });
    expect(run2.inserted).toHaveLength(0);
    expect(run2.alreadyTracked).toBe(1); // dedup — never duplicated
  });
});
