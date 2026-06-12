// Phase 3.5b: range coverage honesty, range-true summary math, adaptive
// x-axis labels, and snapshot-history preservation.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RANGE_MS,
  coverageNote,
  fastestGrowingInWindow,
  historyBeganNote,
} from "@/lib/range";
import { tickLabel } from "@/components/charts/momentum-chart";
import { JsonStore } from "@/lib/store/json-store";
import { makeVideo, makeSnapshot, useTmpCwd, type TmpCwd } from "./helpers";
import type { MetricSnapshot } from "@/lib/types";

const REPO_ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf-8");

const NOW = new Date("2026-06-12T04:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("coverageNote — honest history indicator", () => {
  it("says nothing when the selected range is fully covered", () => {
    expect(coverageNote("24h", hoursAgo(30), NOW)).toBeNull();
    expect(coverageNote("7d", hoursAgo(8 * 24), NOW)).toBeNull();
  });
  it("explains limited history when the range asks for more than exists", () => {
    const note = coverageNote("7d", hoursAgo(15), NOW);
    expect(note).toMatch(/Showing 15 hours of verified history/);
    expect(note).toMatch(/since Jun 1[12]/); // local-time render of the UTC instant
    expect(note).toMatch(/more builds with each scheduled refresh/);
    expect(coverageNote("30d", hoursAgo(15), NOW)).toMatch(/verified history/);
  });
  it("allows ~5% slack so 23.5h of history covers a 24h selection", () => {
    expect(coverageNote("24h", hoursAgo(23.5), NOW)).toBeNull();
    expect(coverageNote("24h", hoursAgo(12), NOW)).toMatch(/Showing 12 hours of verified history/);
  });
  it("All always states the real start of history", () => {
    expect(coverageNote("all", hoursAgo(15), NOW)).toMatch(
      /Showing all verified history · tracking since/,
    );
  });
  it("is silent with no history at all (empty state handles that)", () => {
    expect(coverageNote("7d", null, NOW)).toBeNull();
  });
  it("the sparse-state explainer names the start date, never invents data", () => {
    expect(historyBeganNote(hoursAgo(15))).toMatch(/Historical tracking began Jun 1[12]/);
    expect(historyBeganNote(null)).toMatch(/History will appear/);
  });
});

describe("fastestGrowingInWindow — summary math follows the selected range", () => {
  const video = (id: string) => makeVideo({ id, originalUrl: `https://t.example/${id}` });
  const snap = (videoId: string, at: string, views: number | null): MetricSnapshot =>
    makeSnapshot({ videoId, capturedAt: at, views });

  it("computes gain from first→last confirmed reading INSIDE the window", () => {
    const a = video("a");
    const snaps = new Map([
      [
        "a",
        [
          snap("a", hoursAgo(30), 1000), // outside a 24h window
          snap("a", hoursAgo(20), 1500),
          snap("a", hoursAgo(1), 1800),
        ],
      ],
    ]);
    const win24 = fastestGrowingInWindow([a], snaps, new Date(NOW.getTime() - RANGE_MS["24h"]));
    expect(win24?.gained).toBe(300); // 1800 - 1500, NOT 1800 - 1000
    const win7d = fastestGrowingInWindow([a], snaps, new Date(NOW.getTime() - RANGE_MS["7d"]));
    expect(win7d?.gained).toBe(800); // full history inside 7d
  });
  it("requires two confirmed readings in range — no extrapolation, no fakes", () => {
    const a = video("a");
    const snaps = new Map([["a", [snap("a", hoursAgo(2), 500), snap("a", hoursAgo(1), null)]]]);
    expect(
      fastestGrowingInWindow([a], snaps, new Date(NOW.getTime() - RANGE_MS["24h"])),
    ).toBeNull();
  });
  it("picks the biggest gainer across videos", () => {
    const a = video("a");
    const b = video("b");
    const snaps = new Map([
      ["a", [snap("a", hoursAgo(3), 100), snap("a", hoursAgo(1), 200)]],
      ["b", [snap("b", hoursAgo(3), 100), snap("b", hoursAgo(1), 900)]],
    ]);
    expect(
      fastestGrowingInWindow([a, b], snaps, new Date(NOW.getTime() - RANGE_MS["24h"]))?.video.id,
    ).toBe("b");
  });
});

describe("tickLabel — x-axis adapts to range", () => {
  const iso = "2026-06-11T20:51:00.000Z";
  it("24h shows times", () => {
    expect(tickLabel(iso, "24h", 20 * 3_600_000)).toMatch(/^\d{1,2}:\d{2}/);
  });
  it("7d and 30d show day labels", () => {
    expect(tickLabel(iso, "7d", 5 * 24 * 3_600_000)).toMatch(/^Jun \d{1,2}$/);
    expect(tickLabel(iso, "30d", 20 * 24 * 3_600_000)).toMatch(/^Jun \d{1,2}$/);
  });
  it("All adapts: times for short spans, days for long spans", () => {
    expect(tickLabel(iso, "all", 15 * 3_600_000)).toMatch(/^\d{1,2}:\d{2}/);
    expect(tickLabel(iso, "all", 10 * 24 * 3_600_000)).toMatch(/^Jun \d{1,2}$/);
  });
});

describe("history preservation", () => {
  let tmp: TmpCwd;
  let store: JsonStore;
  beforeEach(async () => {
    tmp = await useTmpCwd();
    store = new JsonStore();
  });
  afterEach(async () => {
    await tmp.cleanup();
  });

  it("snapshots append — a new refresh never overwrites prior history", async () => {
    const v = await store.insertVideo(makeVideo({}));
    await store.addSnapshot(makeSnapshot({ videoId: v.id, capturedAt: hoursAgo(2), views: 100 }));
    await store.addSnapshot(makeSnapshot({ videoId: v.id, capturedAt: hoursAgo(1), views: 150 }));
    const snaps = await store.listSnapshots(v.id);
    expect(snaps).toHaveLength(2);
    expect(new Set(snaps.map((s) => s.views))).toEqual(new Set([100, 150]));
  });
  it("no retention pruning exists anywhere in the store layer", () => {
    for (const p of [
      "src/lib/store/json-store.ts",
      "src/lib/store/prisma-store.ts",
      "src/lib/refresh.ts",
    ]) {
      const src = read(p);
      expect(src).not.toMatch(/deleteSnapshots|pruneSnapshots|deleteMany\(\s*\{\s*where:\s*\{\s*capturedAt/);
    }
  });
  it("the page surfaces history coverage and the chart receives the range", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain("coverageNote(range");
    expect(page).toContain("historyBeganNote(");
    expect(page).toContain("range={range}");
  });
});
