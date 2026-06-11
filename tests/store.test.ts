import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/store/json-store";
import { makeVideo } from "./helpers";
import { useTmpCwd, type TmpCwd } from "./helpers";

let tmp: TmpCwd;
let store: JsonStore;

beforeEach(async () => {
  tmp = await useTmpCwd();
  store = new JsonStore();
});

afterEach(async () => {
  await tmp.cleanup();
});

describe("JsonStore", () => {
  it("reports a non-ephemeral local JSON store", () => {
    const info = store.info();
    expect(info.kind).toBe("json");
    expect(info.ephemeral).toBe(false);
  });

  it("upserts the campaign idempotently by name", async () => {
    const a = await store.upsertCampaign({
      name: "C",
      creatorName: "N",
      company: "W",
      startDate: null,
    });
    const b = await store.upsertCampaign({
      name: "C",
      creatorName: "N",
      company: "W",
      startDate: null,
    });
    expect(b.id).toBe(a.id);
    expect((await store.getCampaign())?.id).toBe(a.id);
  });

  it("finds videos by url or external id, scoped to platform", async () => {
    const v = await store.insertVideo(
      makeVideo({
        platform: "tiktok",
        originalUrl: "https://www.tiktok.com/@x/video/111",
        externalVideoId: "111",
      }),
    );
    expect((await store.findVideoByUrlOrExternalId("tiktok", null, "111"))?.id).toBe(v.id);
    expect(
      (await store.findVideoByUrlOrExternalId("tiktok", "https://www.tiktok.com/@x/video/111", null))?.id,
    ).toBe(v.id);
    expect(await store.findVideoByUrlOrExternalId("instagram", null, "111")).toBeNull();
  });

  it("filters hidden videos unless includeHidden", async () => {
    await store.insertVideo(makeVideo({ hidden: true }));
    await store.insertVideo(makeVideo({ hidden: false }));
    expect(await store.listVideos()).toHaveLength(1);
    expect(await store.listVideos({ includeHidden: true })).toHaveLength(2);
  });

  it("lists snapshots since a cutoff", async () => {
    const v = await store.insertVideo(makeVideo());
    await store.addSnapshot({ videoId: v.id, capturedAt: "2026-06-01T00:00:00.000Z", views: 1, likes: null, comments: null, shares: null, saves: null, bookmarks: null, engagementRate: null, rawJson: null });
    await store.addSnapshot({ videoId: v.id, capturedAt: "2026-06-05T00:00:00.000Z", views: 2, likes: null, comments: null, shares: null, saves: null, bookmarks: null, engagementRate: null, rawJson: null });
    expect(await store.listSnapshots(v.id)).toHaveLength(2);
    expect(await store.listSnapshots(v.id, "2026-06-03T00:00:00.000Z")).toHaveLength(1);
  });

  it("dedupes comments by externalCommentId and refreshes like counts", async () => {
    const v = await store.insertVideo(makeVideo());
    const base = {
      videoId: v.id,
      platform: "tiktok" as const,
      externalCommentId: "c1",
      authorName: "a",
      text: "hello",
      postedAt: null,
      likes: 1,
      replyCount: null,
      sentiment: null,
      needsResponse: false,
      tags: [],
      permalink: null,
      capturedAt: "2026-06-01T00:00:00.000Z",
      rawJson: null,
    };
    const first = await store.upsertComment(base);
    const second = await store.upsertComment({ ...base, likes: 5 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.comment.id).toBe(first.comment.id);
    expect(second.comment.likes).toBe(5);
  });

  it("dedupes id-less comments by text+author", async () => {
    const v = await store.insertVideo(makeVideo());
    const base = {
      videoId: v.id,
      platform: "tiktok" as const,
      externalCommentId: null,
      authorName: "a",
      text: "same text",
      postedAt: null,
      likes: null,
      replyCount: null,
      sentiment: null,
      needsResponse: false,
      tags: [],
      permalink: null,
      capturedAt: "2026-06-01T00:00:00.000Z",
      rawJson: null,
    };
    await store.upsertComment(base);
    const dup = await store.upsertComment(base);
    expect(dup.created).toBe(false);
    expect(await store.listComments({ videoId: v.id })).toHaveLength(1);
  });

  it("orders refresh runs newest first and respects limit", async () => {
    for (const t of ["2026-06-01", "2026-06-03", "2026-06-02"]) {
      await store.createRefreshRun({
        startedAt: `${t}T00:00:00.000Z`,
        finishedAt: null,
        status: "success",
        trigger: "manual",
        platformsAttempted: [],
        videosUpdated: 0,
        commentsUpdated: 0,
        newVideosDiscovered: 0,
        errors: [],
        rawLog: null,
      });
    }
    const runs = await store.listRefreshRuns(2);
    expect(runs).toHaveLength(2);
    expect(runs[0].startedAt.startsWith("2026-06-03")).toBe(true);
  });

  it("dedupe-key lookup only matches OPEN alerts", async () => {
    const a = await store.createAlert({
      campaignId: "c",
      videoId: null,
      platform: null,
      type: "video_spike",
      severity: "opportunity",
      title: "t",
      message: "m",
      suggestedAction: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      reviewedAt: null,
      status: "open",
      dedupeKey: "k1",
    });
    expect((await store.findOpenAlertByDedupeKey("k1"))?.id).toBe(a.id);
    await store.reviewAlert(a.id);
    expect(await store.findOpenAlertByDedupeKey("k1")).toBeNull();
  });

  it("upserts provider config by platform", async () => {
    const base = {
      platform: "tiktok" as const,
      providerType: "apify" as const,
      actorId: "A",
      status: "untested" as const,
      lastTestedAt: null,
      lastTestResult: null,
      detectedFields: [],
      supportsMetadata: false,
      supportsMetrics: false,
      supportsComments: false,
      supportsDiscovery: false,
      inputOverride: null,
      lastSuccessfulRefreshAt: null,
    };
    const a = await store.upsertProviderConfig(base);
    const b = await store.upsertProviderConfig({ ...base, actorId: "B" });
    expect(b.id).toBe(a.id);
    expect((await store.getProviderConfig("tiktok"))?.actorId).toBe("B");
    expect(await store.listProviderConfigs()).toHaveLength(1);
  });

  it("upserts episode groups by name and logs overrides", async () => {
    const e1 = await store.upsertEpisodeGroupByName({ campaignId: "c", name: "Bootcamp", description: null });
    const e2 = await store.upsertEpisodeGroupByName({ campaignId: "c", name: "Bootcamp", description: null });
    expect(e2.id).toBe(e1.id);
    await store.addOverride({ entityType: "video", entityId: "v", field: "title", oldValue: "a", newValue: "b", reason: null });
    expect(await store.listOverrides()).toHaveLength(1);
  });

  it("persists across instances (new store reads the same file)", async () => {
    await store.insertVideo(makeVideo({ originalUrl: "https://www.tiktok.com/@x/video/77" }));
    const fresh = new JsonStore();
    expect(await fresh.listVideos()).toHaveLength(1);
  });
});
