// Phase 3.1: resilient collection — deep metric extraction, merge behavior,
// last-confirmed display, completeness scoring, ranking rules, canonical
// URLs, and the collection-attempt log.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deepFindMetric } from "@/lib/apify/deep-extract";
import {
  mergeNormalizedVideos,
  metricCompleteness,
  normalizeVideoItem,
} from "@/lib/apify/normalize";
import { parseVideoUrl } from "@/lib/url-parse";
import { computeVideoMetrics, rankByConfirmedViews } from "@/lib/metrics";
import { computeCompleteness } from "@/lib/completeness";
import { JsonStore } from "@/lib/store/json-store";
import { makeSnapshot, makeVideo, useTmpCwd, type TmpCwd } from "./helpers";
import type { NormalizedVideo } from "@/lib/types";

const NOW = new Date("2026-06-11T12:00:00.000Z");

describe("deepFindMetric — Facebook deep extraction", () => {
  it("finds nested exact metric names with their paths", () => {
    const raw = {
      feedback: { video_view_count: 4321 },
      likers: { count: 44 },
      total_comment_count: 2,
    };
    expect(deepFindMetric(raw, "views")).toMatchObject({
      value: 4321,
      path: "feedback.video_view_count",
      exact: true,
    });
    expect(deepFindMetric(raw, "likes")?.value).toBe(44);
    expect(deepFindMetric(raw, "comments")?.value).toBe(2);
  });
  it("does not mistake durations, loop counts, or live-viewer fields for views", () => {
    const raw = {
      short_form_video_context: {
        video: { playable_duration_in_ms: 73600 },
        playback_video: { loop_count: 0 },
      },
      media: [{ liveViewerCount: 0 }],
    };
    expect(deepFindMetric(raw, "views")).toBeNull();
  });
  it("feeds normalizeVideoItem so feed-shaped FB items keep their views", () => {
    const n = normalizeVideoItem(
      {
        url: "https://www.facebook.com/reel/123",
        message: { text: "hi" },
        feedback: { video_view_count: 999 },
      },
      "facebook",
    )!;
    expect(n.views).toBe(999);
  });
});

describe("Facebook URL canonicalization", () => {
  it("handles /share/r/ and /videos/ variants", () => {
    expect(parseVideoUrl("https://www.facebook.com/share/r/AbC12xYz/")).toMatchObject({
      platform: "facebook",
      externalVideoId: "AbC12xYz",
    });
    expect(parseVideoUrl("https://www.facebook.com/someone/videos/987654321/")).toMatchObject({
      platform: "facebook",
      externalVideoId: "987654321",
    });
  });
});

function nv(partial: Partial<NormalizedVideo>): NormalizedVideo {
  return {
    platform: "facebook",
    originalUrl: "https://www.facebook.com/reel/1",
    externalVideoId: "1",
    title: null,
    caption: null,
    thumbnailUrl: null,
    publishedAt: null,
    authorName: null,
    authorHandle: null,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    bookmarks: null,
    rawJson: null,
    ...partial,
  };
}

describe("mergeNormalizedVideos — the FB feed/reel-page fix", () => {
  it("the surface with views is never clobbered by the one without", () => {
    const feed = nv({ views: 860, likes: 44, caption: "Day 21" });
    const reelPage = nv({ views: null, likes: 44, comments: 2, thumbnailUrl: "https://t/x.jpg" });
    // Most-complete record becomes the base regardless of order
    const a = mergeNormalizedVideos(feed, reelPage);
    expect(a.views).toBe(860);
    expect(a.comments).toBe(2);
    expect(a.thumbnailUrl).toBe("https://t/x.jpg");
  });
  it("backup actor results fill ONLY the missing fields", () => {
    const primary = nv({ views: null, likes: 50, comments: 3 });
    const backup = nv({ views: 1200, likes: 49 /* older count */ });
    const merged = mergeNormalizedVideos(primary, backup);
    expect(merged.views).toBe(1200); // filled by backup
    expect(merged.likes).toBe(50); // primary wins where it had data
  });
  it("metricCompleteness picks the better base", () => {
    expect(metricCompleteness(nv({ views: 1, likes: 1 }))).toBe(2);
    expect(metricCompleteness(nv({}))).toBe(0);
  });
});

describe("last-confirmed display behavior", () => {
  const video = makeVideo({ platform: "facebook" });
  it("keeps the last confirmed value, flagged stale, when the newest snapshot misses it", () => {
    const snaps = [
      makeSnapshot({ videoId: video.id, capturedAt: "2026-06-11T04:00:00.000Z", views: 492, likes: 28 }),
      makeSnapshot({ videoId: video.id, capturedAt: "2026-06-11T11:00:00.000Z", views: null, likes: 44 }),
    ];
    const m = computeVideoMetrics(video, snaps, NOW);
    expect(m.confirmed.views).toMatchObject({ value: 492, stale: true });
    expect(m.confirmed.likes).toMatchObject({ value: 44, stale: false });
  });
  it("is null when the metric was never confirmed", () => {
    const snaps = [
      makeSnapshot({ videoId: video.id, capturedAt: "2026-06-11T11:00:00.000Z", views: null, likes: 5 }),
    ];
    expect(computeVideoMetrics(video, snaps, NOW).confirmed.views).toBeNull();
  });
});

describe("rankByConfirmedViews — Top Videos rules", () => {
  it("excludes never-confirmed views and ranks stale-confirmed values", () => {
    const a = computeVideoMetrics(makeVideo(), [
      makeSnapshot({ videoId: "a", capturedAt: "2026-06-11T10:00:00.000Z", views: 100 }),
    ], NOW);
    const b = computeVideoMetrics(makeVideo(), [
      makeSnapshot({ videoId: "b", capturedAt: "2026-06-11T09:00:00.000Z", views: 900 }),
      makeSnapshot({ videoId: "b", capturedAt: "2026-06-11T11:00:00.000Z", views: null, likes: 1 }),
    ], NOW);
    const never = computeVideoMetrics(makeVideo(), [
      makeSnapshot({ videoId: "c", capturedAt: "2026-06-11T11:00:00.000Z", views: null, likes: 9 }),
    ], NOW);
    const ranked = rankByConfirmedViews([a, b, never]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].confirmed.views?.value).toBe(900); // stale-confirmed still ranks
    expect(ranked[0].confirmed.views?.stale).toBe(true);
  });
});

describe("completeness scoring", () => {
  it("scores a fully-populated video at 100", () => {
    const video = makeVideo({
      thumbnailUrl: "https://t/x.jpg",
      caption: "cap",
      publishedAt: "2026-06-10T00:00:00.000Z",
      externalVideoId: "1",
    });
    const m = computeVideoMetrics(video, [
      makeSnapshot({
        videoId: video.id,
        capturedAt: "2026-06-11T11:00:00.000Z",
        views: 1, likes: 1, comments: 1, shares: 1,
      }),
    ], NOW);
    const c = computeCompleteness(video, m);
    expect(c.score).toBe(100);
    expect(c.missingFields).toEqual([]);
  });
  it("reports missing fields and does not count shares for YouTube", () => {
    const video = makeVideo({ platform: "youtube", externalVideoId: "x" });
    const m = computeVideoMetrics(video, [], NOW);
    const c = computeCompleteness(video, m);
    expect(c.missingFields).toContain("views");
    expect(c.missingFields).not.toContain("shares");
    expect(c.score).toBeLessThan(50);
  });
});

describe("CollectionAttempt store operations", () => {
  let tmp: TmpCwd;
  let store: JsonStore;
  beforeEach(async () => {
    tmp = await useTmpCwd();
    store = new JsonStore();
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it("records and lists attempts newest-first with platform filter", async () => {
    await store.addCollectionAttempt({
      refreshRunId: "r1", platform: "facebook", provider: "apify",
      actorId: "K", kind: "discover", inputDescription: "startUrls",
      success: true, runId: "run1", itemCount: 3, error: null,
      capturedAt: "2026-06-11T10:00:00.000Z",
    });
    await store.addCollectionAttempt({
      refreshRunId: "r1", platform: "facebook", provider: "apify",
      actorId: "B", kind: "backup", inputDescription: "startUrls",
      success: false, runId: null, itemCount: 0, error: "403",
      capturedAt: "2026-06-11T10:05:00.000Z",
    });
    await store.addCollectionAttempt({
      refreshRunId: "r1", platform: "tiktok", provider: "apify",
      actorId: "G", kind: "videos", inputDescription: "postURLs",
      success: true, runId: "run2", itemCount: 2, error: null,
      capturedAt: "2026-06-11T10:06:00.000Z",
    });
    const fb = await store.listCollectionAttempts(10, "facebook");
    expect(fb).toHaveLength(2);
    expect(fb[0].kind).toBe("backup"); // newest first
    expect(fb[0].error).toBe("403");
    expect(await store.listCollectionAttempts(10)).toHaveLength(3);
  });
});

describe("isLikelyVideoItem — photo/text posts never enter the tracker", () => {
  it("rejects a Facebook photo/permalink post", async () => {
    const { isLikelyVideoItem } = await import("@/lib/apify/normalize");
    const photoPost = {
      url: "https://www.facebook.com/permalink.php?story_fbid=pfbid0Fux&id=615855",
      message: { text: "I've never seen a conference room like this before." },
      likers: { count: 1 },
      attachments: [{ photo_image: { uri: "https://scontent/x.jpg" } }],
    };
    expect(isLikelyVideoItem(photoPost, "facebook")).toBe(false);
  });
  it("accepts Facebook reels (URL form or video markers)", async () => {
    const { isLikelyVideoItem } = await import("@/lib/apify/normalize");
    expect(
      isLikelyVideoItem({ facebookUrl: "https://www.facebook.com/reel/126800" }, "facebook"),
    ).toBe(true);
    expect(
      isLikelyVideoItem(
        {
          url: "https://www.facebook.com/permalink.php?story_fbid=x",
          short_form_video_context: { playback_video: {} },
        },
        "facebook",
      ),
    ).toBe(true);
  });
  it("passes everything through for video-only platforms", async () => {
    const { isLikelyVideoItem } = await import("@/lib/apify/normalize");
    expect(isLikelyVideoItem({ anything: 1 }, "tiktok")).toBe(true);
  });
});
