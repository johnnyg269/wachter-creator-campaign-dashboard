import { describe, expect, it } from "vitest";
import {
  DAY_MS,
  HOUR_MS,
  aggregateTrend,
  computeVideoMetrics,
  deltaOverWindow,
  engagementRate,
  engagements,
  sumNullable,
} from "@/lib/metrics";
import type { MetricSnapshot } from "@/lib/types";
import { makeSnapshot, makeVideo } from "./helpers";

const NOW = new Date("2026-06-11T12:00:00.000Z");
/** ISO timestamp `msAgo` before the fixed test clock. */
const ago = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

describe("sumNullable", () => {
  it("returns null when every input is null/undefined", () => {
    expect(sumNullable([])).toBeNull();
    expect(sumNullable([null, null])).toBeNull();
    expect(sumNullable([undefined, null])).toBeNull();
  });

  it("sums only present values", () => {
    expect(sumNullable([1, null, 2, undefined, 3])).toBe(6);
    expect(sumNullable([0, null])).toBe(0); // a real zero is not "missing"
  });
});

describe("engagements", () => {
  it("is null when no component is available", () => {
    expect(
      engagements({ likes: null, comments: null, shares: null, saves: null, bookmarks: null }),
    ).toBeNull();
  });

  it("sums the available components and skips nulls", () => {
    expect(
      engagements({ likes: 100, comments: 20, shares: null, saves: 5, bookmarks: null }),
    ).toBe(125);
  });
});

describe("engagementRate", () => {
  const base = { likes: 50, comments: 10, shares: null, saves: null, bookmarks: null };

  it("computes engagements / views", () => {
    expect(engagementRate({ views: 1000, ...base })).toBeCloseTo(0.06);
  });

  it("is null when views is null", () => {
    expect(engagementRate({ views: null, ...base })).toBeNull();
  });

  it("is null when views is 0 (no divide-by-zero, no fake rate)", () => {
    expect(engagementRate({ views: 0, ...base })).toBeNull();
  });

  it("is null when engagements is null even with views present", () => {
    expect(
      engagementRate({
        views: 1000,
        likes: null,
        comments: null,
        shares: null,
        saves: null,
        bookmarks: null,
      }),
    ).toBeNull();
  });
});

describe("deltaOverWindow", () => {
  it("covers the full window when a baseline exists at/before now - window", () => {
    const snaps = [
      makeSnapshot({ videoId: "v1", capturedAt: ago(2 * HOUR_MS), views: 100 }),
      makeSnapshot({ videoId: "v1", capturedAt: ago(5 * 60 * 1000), views: 400 }),
    ];
    const d = deltaOverWindow(snaps, HOUR_MS, "views", NOW);
    expect(d).not.toBeNull();
    expect(d?.value).toBe(300);
    expect(d?.coversFullWindow).toBe(true);
    expect(d?.fromTime).toBe(snaps[0].capturedAt);
    expect(d?.toTime).toBe(snaps[1].capturedAt);
  });

  it("falls back to the earliest snapshot with coversFullWindow=false for young videos", () => {
    const snaps = [
      makeSnapshot({ videoId: "v1", capturedAt: ago(30 * 60 * 1000), views: 100 }),
      makeSnapshot({ videoId: "v1", capturedAt: ago(5 * 60 * 1000), views: 250 }),
    ];
    const d = deltaOverWindow(snaps, HOUR_MS, "views", NOW);
    expect(d?.value).toBe(150);
    expect(d?.coversFullWindow).toBe(false);
  });

  it("returns null with fewer than two usable snapshots", () => {
    expect(deltaOverWindow([], HOUR_MS, "views", NOW)).toBeNull();
    expect(
      deltaOverWindow(
        [makeSnapshot({ videoId: "v1", capturedAt: ago(HOUR_MS), views: 100 })],
        HOUR_MS,
        "views",
        NOW,
      ),
    ).toBeNull();
    // Two snapshots but one has a null field → only one usable
    expect(
      deltaOverWindow(
        [
          makeSnapshot({ videoId: "v1", capturedAt: ago(2 * HOUR_MS), views: null }),
          makeSnapshot({ videoId: "v1", capturedAt: ago(5 * 60 * 1000), views: 100 }),
        ],
        HOUR_MS,
        "views",
        NOW,
      ),
    ).toBeNull();
  });

  it("returns null when baseline and latest are the same snapshot (all data older than window)", () => {
    const snaps = [
      makeSnapshot({ videoId: "v1", capturedAt: ago(3 * HOUR_MS), views: 100 }),
      makeSnapshot({ videoId: "v1", capturedAt: ago(2 * HOUR_MS), views: 200 }),
    ];
    expect(deltaOverWindow(snaps, HOUR_MS, "views", NOW)).toBeNull();
  });

  it("works for non-view fields independently of views", () => {
    const snaps = [
      makeSnapshot({ videoId: "v1", capturedAt: ago(2 * HOUR_MS), likes: 50, views: null }),
      makeSnapshot({ videoId: "v1", capturedAt: ago(5 * 60 * 1000), likes: 90, views: null }),
    ];
    const likesDelta = deltaOverWindow(snaps, HOUR_MS, "likes", NOW);
    expect(likesDelta?.value).toBe(40);
    expect(likesDelta?.coversFullWindow).toBe(true);
    // views are all null → no views delta
    expect(deltaOverWindow(snaps, HOUR_MS, "views", NOW)).toBeNull();
  });
});

describe("aggregateTrend", () => {
  const T0 = new Date("2026-06-11T00:00:00.000Z");
  const at = (h: number, m = 0) => new Date(T0.getTime() + h * HOUR_MS + m * 60_000).toISOString();

  const byVideo = new Map<string, MetricSnapshot[]>([
    ["a", [makeSnapshot({ videoId: "a", capturedAt: at(1, 30), views: 100, likes: 10 })]],
    [
      "b",
      [
        makeSnapshot({ videoId: "b", capturedAt: at(0, 30), views: 50, comments: 5 }),
        makeSnapshot({ videoId: "b", capturedAt: at(3, 30), views: 80, comments: 8 }),
      ],
    ],
  ]);

  it("sums each video's latest snapshot at/before each bucket end", () => {
    const points = aggregateTrend(byVideo, T0, new Date(T0.getTime() + 4 * HOUR_MS), 4);
    expect(points).toHaveLength(4);
    expect(points.map((p) => p.t)).toEqual([at(1), at(2), at(3), at(4)]);
    expect(points.map((p) => p.views)).toEqual([50, 150, 150, 180]);
    expect(points.map((p) => p.engagements)).toEqual([5, 15, 15, 18]);
  });

  it("leaves buckets before any data as null gaps, not zeros", () => {
    const points = aggregateTrend(
      byVideo,
      new Date(T0.getTime() - HOUR_MS),
      new Date(T0.getTime() + 3 * HOUR_MS),
      4,
    );
    // First bucket ends at T0, before any snapshot exists.
    expect(points[0].views).toBeNull();
    expect(points[0].engagements).toBeNull();
    expect(points[1].views).toBe(50);
  });

  it("keeps engagements null when a snapshot has views but no engagement fields", () => {
    const viewsOnly = new Map<string, MetricSnapshot[]>([
      ["c", [makeSnapshot({ videoId: "c", capturedAt: at(0, 15), views: 10 })]],
    ]);
    const points = aggregateTrend(viewsOnly, T0, new Date(T0.getTime() + HOUR_MS), 1);
    expect(points[0].views).toBe(10);
    expect(points[0].engagements).toBeNull();
  });

  it("returns [] for an empty/inverted span or zero buckets", () => {
    expect(aggregateTrend(byVideo, T0, T0, 4)).toEqual([]);
    expect(aggregateTrend(byVideo, new Date(T0.getTime() + HOUR_MS), T0, 4)).toEqual([]);
    expect(aggregateTrend(byVideo, T0, new Date(T0.getTime() + HOUR_MS), 0)).toEqual([]);
  });
});

describe("computeVideoMetrics", () => {
  const video = makeVideo({ id: "video-metrics-1" });

  it("rolls up latest snapshot, deltas, and growth since tracked", () => {
    const snaps = [
      makeSnapshot({
        videoId: video.id,
        capturedAt: ago(2 * DAY_MS),
        views: 100,
        likes: 10,
        comments: 2,
      }),
      makeSnapshot({
        videoId: video.id,
        capturedAt: ago(2 * HOUR_MS),
        views: 900,
        likes: 80,
        comments: 15,
      }),
      makeSnapshot({
        videoId: video.id,
        capturedAt: ago(5 * 60 * 1000),
        views: 1000,
        likes: 90,
        comments: 20,
        shares: 10,
      }),
    ];
    const m = computeVideoMetrics(video, snaps, NOW);
    expect(m.video).toBe(video);
    expect(m.latest?.views).toBe(1000);
    expect(m.engagements).toBe(120); // 90 + 20 + 10
    expect(m.engagementRate).toBeCloseTo(0.12);
    expect(m.delta24h?.value).toBe(900); // vs the 2-day-old baseline
    expect(m.delta24h?.coversFullWindow).toBe(true);
    expect(m.delta1h?.value).toBe(100); // vs the 2-hour-old baseline
    expect(m.delta1h?.coversFullWindow).toBe(true);
    expect(m.growthSinceTracked).toBe(900); // 1000 - 100
  });

  it("returns null growth for a single snapshot and null everything with none", () => {
    const single = computeVideoMetrics(
      video,
      [makeSnapshot({ videoId: video.id, capturedAt: ago(HOUR_MS), views: 500, likes: 5 })],
      NOW,
    );
    expect(single.growthSinceTracked).toBeNull();
    expect(single.delta24h).toBeNull();
    expect(single.delta1h).toBeNull();
    expect(single.delta10m).toBeNull();
    expect(single.engagements).toBe(5);

    const empty = computeVideoMetrics(video, [], NOW);
    expect(empty.latest).toBeNull();
    expect(empty.engagements).toBeNull();
    expect(empty.engagementRate).toBeNull();
    expect(empty.growthSinceTracked).toBeNull();
  });

  it("never treats null views as zero in growth", () => {
    const snaps = [
      makeSnapshot({ videoId: video.id, capturedAt: ago(2 * HOUR_MS), views: null, likes: 10 }),
      makeSnapshot({ videoId: video.id, capturedAt: ago(5 * 60 * 1000), views: 800, likes: 20 }),
    ];
    const m = computeVideoMetrics(video, snaps, NOW);
    // Only one snapshot has views → no growth claim.
    expect(m.growthSinceTracked).toBeNull();
    expect(m.latest?.views).toBe(800);
  });
});

describe("deltaOverWindow — stale baseline honesty", () => {
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  it("refuses to claim a short-window delta against an ancient baseline", () => {
    // Snapshots 7h apart must not produce a "+N in the last 10 minutes" claim.
    const snaps = [
      makeSnapshot({ videoId: "v1", capturedAt: ago(7 * HOUR_MS), views: 1000 }),
      makeSnapshot({ videoId: "v1", capturedAt: ago(60 * 1000), views: 4200 }),
    ];
    expect(deltaOverWindow(snaps, 10 * 60 * 1000, "views", NOW)).toBeNull();
    // ...but the same data IS an honest partial 24h delta (tracking < 24h old).
    const day = deltaOverWindow(snaps, 24 * HOUR_MS, "views", NOW);
    expect(day?.value).toBe(3200);
    expect(day?.coversFullWindow).toBe(false);
  });
});
