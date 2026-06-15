// Facebook view-accuracy fix (urgent): the actor's `viewsCount` is a stricter
// metric than the public Reel "plays" count and it exposes no plays field. The
// view resolver prefers a real play/view field or a safe formatted display
// string, falls back to the `viewsCount` proxy, and rejects unrelated counts;
// a pinned manual correction lets the admin set the real public value durably.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { resolveViews, parseDisplayCount } from "@/lib/apify/view-resolver";
import { normalizeVideoItem, mergeNormalizedVideos, resolveThumb } from "@/lib/apify/normalize";
import { applyMonotonicViews, computeVideoMetrics } from "@/lib/metrics";
import { makeVideo, makeSnapshot } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

describe("parseDisplayCount — safe K/M/B parsing", () => {
  it("parses formatted view strings", () => {
    expect(parseDisplayCount("124K")).toBe(124_000);
    expect(parseDisplayCount("1.2M")).toBe(1_200_000);
    expect(parseDisplayCount("90K views")).toBe(90_000);
    expect(parseDisplayCount("1,234,567")).toBe(1_234_567);
    expect(parseDisplayCount("987")).toBe(987);
  });
  it("rejects anything that isn't unambiguously a count", () => {
    expect(parseDisplayCount("2:14")).toBeNull();
    expect(parseDisplayCount("HD")).toBeNull();
    expect(parseDisplayCount("")).toBeNull();
    expect(parseDisplayCount("1.2.3")).toBeNull();
  });
});

describe("resolveViews (facebook)", () => {
  it("prefers a true play/view count over the stricter viewsCount proxy", () => {
    const r = resolveViews({ viewsCount: 54907, video_view_count: 124000 }, "facebook");
    expect(r.value).toBe(124000);
    expect(r.confidence).toBe("exact");
    expect(r.extractionPath).toBe("video_view_count");
  });
  it("parses a formatted public play-count string when no numeric play field exists", () => {
    const r = resolveViews({ play_count_formatted: "124K", viewsCount: 54907 }, "facebook");
    expect(r.value).toBe(124000);
    expect(r.confidence).toBe("display_string");
    expect(r.rawDisplayValue).toBe("124K");
  });
  it("falls back to the real viewsCount proxy (today's FB actor shape)", () => {
    const r = resolveViews({ viewsCount: 54907 }, "facebook");
    expect(r.value).toBe(54907);
    expect(r.confidence).toBe("proxy");
    expect(r.extractionPath).toBe("viewsCount");
    expect(r.sourceSurface).toBe("feed");
  });
  it("rejects unrelated counts (reactions/likes/comments/shares/duration/live-viewer/loop)", () => {
    const r = resolveViews(
      {
        likes: 501,
        comments: 134,
        shares: 40,
        topReactionsCount: 5,
        reactionLikeCount: 482,
        media: [{ liveViewerCount: 0, loop_count: 0, playable_duration_in_ms: 61166 }],
      },
      "facebook",
    );
    expect(r.value).toBeNull();
    expect(r.confidence).toBe("none");
  });
});

describe("normalizeVideoItem view extraction", () => {
  it("FB reel uses viewsCount", () => {
    const n = normalizeVideoItem({ url: "https://facebook.com/reel/123", viewsCount: 54907, likes: 501 }, "facebook");
    expect(n?.views).toBe(54907);
  });
  it("Instagram keeps play-count-first behavior (no regression)", () => {
    const n = normalizeVideoItem(
      { url: "https://instagram.com/reel/abc", videoViewCount: 1000, videoPlayCount: 2200 },
      "instagram",
    );
    expect(n?.views).toBe(2200);
  });
});

describe("Facebook monotonic protection + durable manual correction", () => {
  it("a partial/lower automated value never overwrites a higher confirmed value", () => {
    expect(applyMonotonicViews(54907, 124000)).toEqual({ views: null, rejectedLower: 54907 });
  });
  it("a higher verified count corrects a previously low value", () => {
    expect(applyMonotonicViews(124000, 54907)).toEqual({ views: 124000, rejectedLower: null });
  });
  it("a PINNED manual correction persists past 24h and outranks lower automated values", () => {
    const v = makeVideo({ id: "fb1", platform: "facebook" });
    const now = new Date("2026-06-15T23:00:00Z");
    const snaps = [
      makeSnapshot({ videoId: "fb1", capturedAt: "2026-06-10T00:00:00Z", views: 50000 }),
      makeSnapshot({ videoId: "fb1", capturedAt: "2026-06-11T00:00:00Z", views: 124000, rawJson: { manual: true, pinned: true } }),
      makeSnapshot({ videoId: "fb1", capturedAt: "2026-06-15T22:00:00Z", views: null }), // automated lower → rejected → null
    ];
    const m = computeVideoMetrics(v, snaps, now);
    expect(m.confirmed.views?.value).toBe(124000);
    expect(m.confirmed.views?.manual).toBe(true);
  });
  it("a NON-pinned 24h manual spot-check still expires (unchanged behavior)", () => {
    const v = makeVideo({ id: "fb2", platform: "facebook" });
    const now = new Date("2026-06-15T23:00:00Z");
    const snaps = [
      makeSnapshot({ videoId: "fb2", capturedAt: "2026-06-10T00:00:00Z", views: 40000 }),
      makeSnapshot({ videoId: "fb2", capturedAt: "2026-06-11T00:00:00Z", views: 90000, rawJson: { manual: true } }),
    ];
    const m = computeVideoMetrics(v, snaps, now);
    expect(m.confirmed.views?.value).toBe(40000);
  });
});

describe("Facebook dedupe + thumbnails + last-known-good intact", () => {
  it("surface merge keeps higher confirmed views + best thumbnail", () => {
    const feed = normalizeVideoItem({ url: "https://facebook.com/reel/9", viewsCount: 54907 }, "facebook")!;
    const reelPage = normalizeVideoItem(
      { url: "https://facebook.com/reel/9", short_form_video_context: { playback_video: { preferred_thumbnail: { image: { uri: "https://scontent.example/t.jpg" } } } } },
      "facebook",
    )!;
    const merged = mergeNormalizedVideos(feed, reelPage);
    expect(merged.views).toBe(54907);
    expect(merged.thumbnailUrl).toBe("https://scontent.example/t.jpg");
  });
  it("FB thumbnail resolver still works", () => {
    const t = resolveThumb({ short_form_video_context: { playback_video: { preferred_thumbnail: { image: { uri: "https://img.example/x.jpg" } } } } });
    expect(t?.url).toBe("https://img.example/x.jpg");
  });
  it("last-known-good: an older confirmed value survives a null latest snapshot", () => {
    const v = makeVideo({ id: "fb3", platform: "facebook" });
    const now = new Date("2026-06-15T23:00:00Z");
    const snaps = [
      makeSnapshot({ videoId: "fb3", capturedAt: "2026-06-14T00:00:00Z", views: 39797 }),
      makeSnapshot({ videoId: "fb3", capturedAt: "2026-06-15T00:00:00Z", views: null }),
    ];
    const m = computeVideoMetrics(v, snaps, now);
    expect(m.confirmed.views?.value).toBe(39797);
    expect(m.confirmed.views?.stale).toBe(true);
  });
});

describe("safety — no secrets / actor IDs / fetches in the new view code", () => {
  it("view-resolver is pure and clean", () => {
    const f = read("src/lib/apify/view-resolver.ts");
    expect(f).not.toMatch(/apify/i);
    expect(f).not.toContain("actorId");
    expect(f).not.toMatch(/fetch\(/);
    expect(f).not.toMatch(/AIza[0-9A-Za-z_-]{10}/);
  });
});
