// Phase 3.2: data-confidence badge and hero insight computation.

import { describe, expect, it } from "vitest";
import { computeConfidence, computeInsights } from "@/lib/executive";
import { computeVideoMetrics } from "@/lib/metrics";
import type { PlatformStats } from "@/lib/queries";
import { makeSnapshot, makeVideo } from "./helpers";

const NOW = new Date("2026-06-11T12:00:00.000Z");

function metricsWith(views: number | null, opts: { stale?: boolean } = {}) {
  const video = makeVideo();
  const snaps =
    views === null
      ? [makeSnapshot({ videoId: video.id, capturedAt: "2026-06-11T11:00:00.000Z", likes: 1 })]
      : opts.stale
        ? [
            makeSnapshot({ videoId: video.id, capturedAt: "2026-06-11T10:00:00.000Z", views }),
            makeSnapshot({ videoId: video.id, capturedAt: "2026-06-11T11:00:00.000Z", views: null, likes: 1 }),
          ]
        : [makeSnapshot({ videoId: video.id, capturedAt: "2026-06-11T11:00:00.000Z", views })];
  return computeVideoMetrics(video, snaps, NOW);
}

describe("computeConfidence", () => {
  it("is high when every video has current confirmed views", () => {
    const c = computeConfidence([metricsWith(100), metricsWith(200)]);
    expect(c.level).toBe("high");
    expect(c.detail).toBe("All tracked videos have confirmed view counts.");
    expect(c.verifiedAt).toBe("2026-06-11T11:00:00.000Z");
  });
  it("is partial when some views are stale — worded calmly (core metrics verified)", () => {
    const c = computeConfidence([metricsWith(100), metricsWith(200, { stale: true })]);
    expect(c.level).toBe("partial");
    expect(c.headline).toBe("Core metrics verified");
    expect(c.detail).toMatch(
      /Every video has confirmed views; 1 is showing the count from a prior refresh/,
    );
  });
  it("is building when a video has never-confirmed views", () => {
    const c = computeConfidence([metricsWith(100), metricsWith(null)]);
    expect(c.level).toBe("building");
    expect(c.detail).toMatch(/1 of 2 videos awaiting/);
  });
});

describe("computeInsights", () => {
  const stats = (platform: string, views: number | null, er: number | null): PlatformStats =>
    ({ platform, views, engagementRate: er }) as PlatformStats;

  it("computes real-value insight lines in priority order", () => {
    const lines = computeInsights({
      videosTracked: 8,
      platformsLive: 4,
      platformStats: [
        stats("tiktok", 7200, 0.039),
        stats("instagram", 6200, 0.05),
        stats("youtube", 2600, 0.045),
        stats("facebook", 2400, 0.035),
      ],
      needsResponse: 4,
      discoveryEnabled: true,
    });
    expect(lines[0]).toBe("8 videos tracked across 4 platforms");
    expect(lines[1]).toMatch(/TikTok is driving the most views \(7\.2K\)/);
    expect(lines[2]).toMatch(/Instagram Reels has the strongest engagement rate \(5\.0%\)/);
    expect(lines[3]).toMatch(/4 audience comments may deserve a response/);
    expect(lines.length).toBeLessThanOrEqual(4);
  });
  it("omits the engagement line when the views leader also leads engagement", () => {
    const lines = computeInsights({
      videosTracked: 2,
      platformsLive: 1,
      platformStats: [stats("tiktok", 5000, 0.08)],
      needsResponse: 0,
      discoveryEnabled: true,
    });
    expect(lines.join(" ")).not.toMatch(/strongest engagement/);
    expect(lines).toContain("New posts are discovered automatically on refresh");
  });
});
