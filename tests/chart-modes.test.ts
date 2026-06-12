// Phase 3.8: platform contribution by default, Total/Velocity modes,
// surge annotations, and growth leaders — all from real data only.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { findSurges } from "@/components/charts/momentum-chart";
import { topGrowersInWindow, RANGE_MS } from "@/lib/range";
import { makeVideo, makeSnapshot } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

type Gains = { views: number | null; engagements: number | null; comments: number | null };
const g = (views: number | null): Gains => ({ views, engagements: null, comments: null });

function row(t: string, gainedViews: number | null, byPlatformGains: Record<string, number> = {}) {
  return {
    t,
    gained: g(gainedViews),
    gainedByPlatform: Object.fromEntries(
      Object.entries(byPlatformGains).map(([p, v]) => [p, g(v)]),
    ),
  };
}

describe("findSurges — surge annotations from real deltas", () => {
  const rows = [
    row("t1", 100),
    row("t2", 120),
    row("t3", 5000, { instagram: 4200, tiktok: 800 }), // big jump, IG-driven
    row("t4", 90),
    row("t5", 300, { tiktok: 200, youtube: 100 }),
    row("t6", 110), // latest
  ];
  it("annotates only meaningful jumps (>=1.5x avg positive step), max 2", () => {
    const surges = findSurges(rows, "views", "t6");
    expect(surges.length).toBeGreaterThanOrEqual(1);
    expect(surges.length).toBeLessThanOrEqual(2);
    expect(surges[0].t).toBe("t3");
  });
  it("attributes the surge to a platform when it caused >50% of the jump", () => {
    const surges = findSurges(rows, "views", "t6");
    expect(surges[0].label).toContain("Instagram Reels spike");
    expect(surges[0].label).toContain("+5K");
  });
  it("never annotates the latest point (the Now marker owns it)", () => {
    const surges = findSurges(rows, "views", "t3"); // pretend the spike IS latest
    expect(surges.find((s) => s.t === "t3")).toBeUndefined();
  });
  it("returns nothing for sparse data — no invented annotations", () => {
    expect(findSurges([row("t1", 100), row("t2", 5000)], "views", null)).toEqual([]);
  });
});

describe("topGrowersInWindow — growth leaders", () => {
  const NOW = new Date("2026-06-12T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  it("ranks by in-window gain with share of combined growth", () => {
    const a = makeVideo({ id: "a", originalUrl: "https://x/a" });
    const b = makeVideo({ id: "b", originalUrl: "https://x/b" });
    const snaps = new Map([
      ["a", [makeSnapshot({ videoId: "a", capturedAt: hoursAgo(3), views: 100 }), makeSnapshot({ videoId: "a", capturedAt: hoursAgo(1), views: 400 })]],
      ["b", [makeSnapshot({ videoId: "b", capturedAt: hoursAgo(3), views: 100 }), makeSnapshot({ videoId: "b", capturedAt: hoursAgo(1), views: 800 })]],
    ]);
    const leaders = topGrowersInWindow([a, b], snaps, new Date(NOW.getTime() - RANGE_MS["24h"]), 3);
    expect(leaders.map((l) => l.video.id)).toEqual(["b", "a"]);
    expect(leaders[0].gained).toBe(700);
    expect(leaders[0].sharePct).toBe(70);
    expect(leaders[1].sharePct).toBe(30);
    expect(leaders[0].currentViews).toBe(800);
  });
  it("excludes videos without two confirmed in-window readings", () => {
    const a = makeVideo({ id: "a" });
    const snaps = new Map([["a", [makeSnapshot({ videoId: "a", capturedAt: hoursAgo(1), views: 500 })]]]);
    expect(topGrowersInWindow([a], snaps, new Date(NOW.getTime() - RANGE_MS["24h"]))).toEqual([]);
  });
});

describe("chart structure (source-level)", () => {
  const chart = read("src/components/charts/momentum-chart.tsx");
  it("platform contribution stack renders in the DEFAULT total mode (no hidden menu)", () => {
    expect(chart).toContain('stackId="platforms"');
    expect(chart).toContain('useState<ChartMode>("total")');
  });
  it("the cumulative total line remains and draws above the stack", () => {
    expect(chart.indexOf('stackId="platforms"')).toBeLessThan(chart.indexOf('key="total"'));
    expect(chart).toContain('dataKey={metric}');
  });
  it("velocity mode plots real per-interval deltas as stacked platform bars", () => {
    expect(chart).toContain('stackId="gains"');
    expect(chart).toContain("g_${platform}_${m}");
    // Deltas come only from consecutive real readings.
    expect(chart).toContain("prevP[m] !== null");
  });
  it("missing readings never become zeros", () => {
    expect(chart).toContain("connectNulls={false}");
    // Flattened plot keys keep nulls as nulls — never coerced to 0 for display.
    expect(chart).toContain("? gains[m] : null");
    expect(chart).toContain("a missing reading is never drawn as 0");
  });
  it("tooltip shows platform totals, interval gains, share %, and top contributor", () => {
    expect(chart).toContain("drove this interval");
    expect(chart).toContain("intervalTotalGain");
    expect(chart).toContain("sharePct");
  });
  it("animations respect prefers-reduced-motion", () => {
    expect(chart).toContain("prefers-reduced-motion");
    expect(chart.match(/isAnimationActive=\{!reducedMotion\}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
  it("sparse velocity data shows a clean note instead of fake bars", () => {
    expect(chart).toContain("Velocity needs at least two readings");
  });
  it("the page rail renders growth leaders from the selected range", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain("Growth leaders");
    expect(page).toContain("data.growthLeaders");
    expect(page).toContain("% of growth");
  });
});
