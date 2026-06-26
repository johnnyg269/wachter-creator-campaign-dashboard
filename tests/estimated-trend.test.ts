// Display-only estimated historical trend: Bootcamp videos ramp 0→first-real
// from publish date; everything else is actual; after the first real snapshot the
// series equals the real aggregateTrend exactly (so future growth is actual and
// KPIs are never affected). Estimated values are display-only — never written.

import { describe, expect, it } from "vitest";
import { aggregateEstimatedTrend, aggregateTrend, type EstimatedVideoMeta } from "@/lib/metrics";
import type { MetricSnapshot } from "@/lib/types";

const snap = (over: Partial<MetricSnapshot>): MetricSnapshot => ({
  id: "s", videoId: "v", capturedAt: "2026-06-01T00:00:00.000Z",
  views: null, likes: null, comments: null, shares: null, saves: null, bookmarks: null,
  engagementRate: null, rawJson: null, ...over,
});

describe("aggregateEstimatedTrend", () => {
  const from = new Date("2026-04-01T00:00:00.000Z");
  const to = new Date("2026-07-01T00:00:00.000Z");

  it("ramps a Bootcamp video 0→first-views from publish date; 0 before publish", () => {
    // Published Apr 11, first (only) real snapshot Jul 1 with 1000 views.
    const meta: EstimatedVideoMeta[] = [{ id: "v", publishedAt: "2026-04-11T00:00:00.000Z", estimated: true }];
    const snaps = new Map([["v", [snap({ capturedAt: "2026-07-01T00:00:00.000Z", views: 1000 })]]]);
    const pts = aggregateEstimatedTrend(meta, snaps, from, to, 6); // ~15d buckets
    // First bucket (~Apr 16) is just after publish → small positive ramp value.
    expect(pts[0].views).not.toBeNull();
    expect(pts[0].views as number).toBeGreaterThanOrEqual(0);
    // Monotonic non-decreasing ramp toward 1000.
    for (let i = 1; i < pts.length; i++) {
      expect((pts[i].views as number)).toBeGreaterThanOrEqual(pts[i - 1].views as number);
    }
    // Final bucket (= to, at/after the real snapshot) equals the real value.
    expect(pts[pts.length - 1].views).toBe(1000);
  });

  it("estimated views are 0 before the publish date", () => {
    const meta: EstimatedVideoMeta[] = [{ id: "v", publishedAt: "2026-06-15T00:00:00.000Z", estimated: true }];
    const snaps = new Map([["v", [snap({ capturedAt: "2026-06-20T00:00:00.000Z", views: 500 })]]]);
    const pts = aggregateEstimatedTrend(meta, snaps, from, to, 6);
    // Early buckets (well before Jun 15) must be 0, not a ramp.
    expect(pts[0].views).toBe(0);
  });

  it("equals aggregateTrend exactly once every video has a real snapshot (future is actual)", () => {
    // Two videos with real history starting early May; window May→Jul.
    const snaps = new Map<string, MetricSnapshot[]>([
      ["a", [snap({ videoId: "a", capturedAt: "2026-05-02T00:00:00.000Z", views: 100, likes: 5, comments: 2 }), snap({ videoId: "a", capturedAt: "2026-06-02T00:00:00.000Z", views: 300, likes: 9, comments: 4 })]],
      ["b", [snap({ videoId: "b", capturedAt: "2026-05-03T00:00:00.000Z", views: 50, likes: 1, comments: 1 })]],
    ]);
    const meta: EstimatedVideoMeta[] = [
      { id: "a", publishedAt: "2026-05-01T00:00:00.000Z", estimated: true },
      { id: "b", publishedAt: "2026-05-01T00:00:00.000Z", estimated: false },
    ];
    const win = { from: new Date("2026-05-10T00:00:00.000Z"), to: new Date("2026-07-01T00:00:00.000Z") };
    const real = aggregateTrend(snaps, win.from, win.to, 5);
    const est = aggregateEstimatedTrend(meta, snaps, win.from, win.to, 5);
    // Window starts after both first snapshots → estimated must equal real byte-for-byte.
    expect(est).toEqual(real);
  });

  it("non-estimated videos behave exactly like aggregateTrend (no ramp, nulls preserved)", () => {
    const snaps = new Map([["v", [snap({ capturedAt: "2026-06-20T00:00:00.000Z", views: 777 })]]]);
    const meta: EstimatedVideoMeta[] = [{ id: "v", publishedAt: "2026-04-11T00:00:00.000Z", estimated: false }];
    const est = aggregateEstimatedTrend(meta, snaps, from, to, 6);
    const real = aggregateTrend(snaps, from, to, 6);
    expect(est).toEqual(real); // identical when nothing is estimated
  });

  it("no ramp bleed: a lagging field (eng) matches aggregateTrend at/after the video's first snapshot", () => {
    // Snapshot A has views but NO engagement; B (later) adds likes. The eng ramp
    // must STOP at the video's first snapshot (A), not keep ramping until B.
    const snaps = new Map([["v", [
      snap({ capturedAt: "2026-05-01T00:00:00.000Z", views: 500 }),
      snap({ capturedAt: "2026-06-01T00:00:00.000Z", likes: 80 }),
    ]]]);
    const meta: EstimatedVideoMeta[] = [{ id: "v", publishedAt: "2026-04-01T00:00:00.000Z", estimated: true }];
    const win = { from: new Date("2026-05-01T00:00:00.000Z"), to: new Date("2026-07-01T00:00:00.000Z") };
    const real = aggregateTrend(snaps, win.from, win.to, 6);
    const est = aggregateEstimatedTrend(meta, snaps, win.from, win.to, 6);
    // Window starts at the first snapshot → estimated must equal real for ALL fields
    // (no fabricated engagement in the views-only gap between A and B).
    expect(est).toEqual(real);
  });

  it("no 0-floor: a Bootcamp video with no snapshots contributes null, not 0", () => {
    const meta: EstimatedVideoMeta[] = [{ id: "v", publishedAt: "2026-04-11T00:00:00.000Z", estimated: true }];
    const snaps = new Map<string, MetricSnapshot[]>(); // no snapshots at all
    const est = aggregateEstimatedTrend(meta, snaps, from, to, 6);
    const real = aggregateTrend(snaps, from, to, 6);
    expect(est).toEqual(real); // all-null, never floored to 0
    expect(est.every((p) => p.views === null)).toBe(true);
  });

  it("a Bootcamp video with no publish date cannot ramp — treated as actual (no fake history)", () => {
    const snaps = new Map([["v", [snap({ capturedAt: "2026-06-20T00:00:00.000Z", views: 200 })]]]);
    const meta: EstimatedVideoMeta[] = [{ id: "v", publishedAt: null, estimated: true }];
    const est = aggregateEstimatedTrend(meta, snaps, from, to, 6);
    const real = aggregateTrend(snaps, from, to, 6);
    expect(est).toEqual(real); // no publish anchor → falls back to actual carry-forward
  });
});
