// Phase 3.3c: Instagram accuracy — play-count field priority, monotonic
// views, error-stub filtering, combined-input freshness, manual verification
// flags/expiry, frozen-views detection, and platform freshness levels.

import { describe, expect, it } from "vitest";
import { normalizeVideoItem } from "@/lib/apify/normalize";
import { buildInputCandidates } from "@/lib/apify/input-builder";
import {
  applyMonotonicViews,
  computeVideoMetrics,
  isViewsFrozen,
} from "@/lib/metrics";
import { platformFreshness } from "@/lib/executive";
import { makeSnapshot, makeVideo } from "./helpers";

const NOW = new Date("2026-06-12T00:30:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("Instagram play-count priority (the 9.7K vs 16K root cause)", () => {
  it("prefers videoPlayCount (what the IG app displays) over videoViewCount", () => {
    const n = normalizeVideoItem(
      {
        url: "https://www.instagram.com/reel/DZdZT4Uiu1T/",
        videoViewCount: 9700,
        videoPlayCount: 16123,
        likesCount: 500,
      },
      "instagram",
    )!;
    expect(n.views).toBe(16123);
  });
  it("still reads videoViewCount when plays are absent", () => {
    const n = normalizeVideoItem(
      { url: "https://www.instagram.com/reel/x/", videoViewCount: 4743 },
      "instagram",
    )!;
    expect(n.views).toBe(4743);
  });
  it("TikTok playCount behavior is unchanged", () => {
    const n = normalizeVideoItem(
      { webVideoUrl: "https://www.tiktok.com/@x/video/1", playCount: 2417, diggCount: 42 },
      "tiktok",
    )!;
    expect(n.views).toBe(2417);
  });
});

describe("monotonic views", () => {
  it("a lower reading is rejected (recorded null) and reported", () => {
    expect(applyMonotonicViews(9700, 16123)).toEqual({ views: null, rejectedLower: 9700 });
  });
  it("higher or equal readings pass through", () => {
    expect(applyMonotonicViews(19231, 16123)).toEqual({ views: 19231, rejectedLower: null });
    expect(applyMonotonicViews(16123, 16123)).toEqual({ views: 16123, rejectedLower: null });
  });
  it("null reading and no-history cases pass through unchanged", () => {
    expect(applyMonotonicViews(null, 100)).toEqual({ views: null, rejectedLower: null });
    expect(applyMonotonicViews(50, null)).toEqual({ views: 50, rejectedLower: null });
  });
});

describe("error-stub filtering", () => {
  it("does not ingest {error, url} stubs as videos", () => {
    expect(
      normalizeVideoItem(
        {
          error: "restricted_page",
          errorDescription: "Page is restricted",
          url: "https://www.instagram.com/reel/DZdMwoFJMYu/",
        },
        "instagram",
      ),
    ).toBeNull();
  });
  it("keeps items that carry real content despite an error field", () => {
    expect(
      normalizeVideoItem(
        { error: "partial", url: "https://www.instagram.com/reel/x/", caption: "hello", videoPlayCount: 10 },
        "instagram",
      ),
    ).not.toBeNull();
  });
});

describe("Instagram combined discovery input", () => {
  it("rides tracked reel URLs along with the profile in one run", () => {
    const [c] = buildInputCandidates("instagram", "xMc5Ga1oCONPmWJIa", "discover", {
      profileUrl: "https://www.instagram.com/cybernick0x",
      knownVideoUrls: [
        "https://www.instagram.com/reel/DZdZT4Uiu1T/",
        "https://www.instagram.com/reel/DZWaZjlggrV/",
      ],
      limit: 30,
    });
    expect(c.input.username).toEqual([
      "https://www.instagram.com/cybernick0x",
      "https://www.instagram.com/reel/DZdZT4Uiu1T/",
      "https://www.instagram.com/reel/DZWaZjlggrV/",
    ]);
  });
});

describe("manual verification flag and expiry", () => {
  const video = makeVideo();
  it("marks manual snapshot values and they win while fresh", () => {
    const m = computeVideoMetrics(video, [
      makeSnapshot({ videoId: video.id, capturedAt: ago(60), views: 9700 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(10), views: 15800, rawJson: { manual: true } }),
    ], NOW);
    expect(m.confirmed.views).toMatchObject({ value: 15800, manual: true });
  });
  it("manual values expire after 24h, falling back to automated", () => {
    const m = computeVideoMetrics(video, [
      makeSnapshot({ videoId: video.id, capturedAt: ago(60 * 30), views: 9000 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(60 * 25), views: 15800, rawJson: { manual: true } }),
    ], NOW);
    expect(m.confirmed.views).toMatchObject({ value: 9000, manual: false });
  });
});

describe("isViewsFrozen", () => {
  const video = makeVideo();
  it("detects identical views across 3+ snapshots spanning 12+ minutes", () => {
    const snaps = [
      makeSnapshot({ videoId: video.id, capturedAt: ago(20), views: 5000 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(12), views: 5000 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(4), views: 5000 }),
    ];
    expect(isViewsFrozen(snaps, NOW)).toBe(true);
  });
  it("growing views are not frozen", () => {
    const snaps = [
      makeSnapshot({ videoId: video.id, capturedAt: ago(20), views: 5000 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(12), views: 5400 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(4), views: 6100 }),
    ];
    expect(isViewsFrozen(snaps, NOW)).toBe(false);
  });
  it("needs at least 3 snapshots and a 12-minute span", () => {
    expect(isViewsFrozen([
      makeSnapshot({ videoId: video.id, capturedAt: ago(8), views: 5000 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(4), views: 5000 }),
    ], NOW)).toBe(false);
    expect(isViewsFrozen([
      makeSnapshot({ videoId: video.id, capturedAt: ago(9), views: 5000 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(5), views: 5000 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(1), views: 5000 }),
    ], NOW)).toBe(false);
  });
});

describe("platformFreshness", () => {
  it("levels: failed > stale > frozen-partial > age-partial > high", () => {
    expect(platformFreshness({ failed: true, verifiedAt: ago(1), topVideoFrozen: false, now: NOW }).level).toBe("failed");
    expect(platformFreshness({ failed: false, verifiedAt: null, topVideoFrozen: false, now: NOW }).level).toBe("stale");
    expect(platformFreshness({ failed: false, verifiedAt: ago(45), topVideoFrozen: false, now: NOW })).toMatchObject({
      level: "stale",
      note: "data may be delayed",
    });
    expect(platformFreshness({ failed: false, verifiedAt: ago(3), topVideoFrozen: true, now: NOW }).level).toBe("partial");
    expect(platformFreshness({ failed: false, verifiedAt: ago(15), topVideoFrozen: false, now: NOW }).level).toBe("partial");
    expect(platformFreshness({ failed: false, verifiedAt: ago(3), topVideoFrozen: false, now: NOW })).toEqual({
      level: "high",
      note: null,
    });
  });
});
