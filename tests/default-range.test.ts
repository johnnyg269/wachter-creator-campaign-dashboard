// Homepage default time range = 30d. The range is URL-param driven (no
// localStorage): parseRange(sp.range) falls back to "30d" ONLY when no ?range=
// param exists, and every explicit selection (24h/7d/30d/all) is respected
// because the RangeSwitcher always emits explicit ?range= links. Videos and
// Reports keep their own defaults. KPI totals are lifetime values and must be
// identical across ranges (the default change cannot recalculate them).

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDashboardData } from "@/lib/queries";
import { getStore } from "@/lib/store";
import { ensureSeedData } from "@/lib/seed";
import { useTmpCwd, stashEnv, makeSnapshot, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── Source-level: defaults + explicit-selection behavior ────────────────────
describe("homepage default range", () => {
  const home = read("src/app/page.tsx");

  it("defaults to 30d when no ?range= param exists", () => {
    const fn = home.slice(home.indexOf("function parseRange"), home.indexOf("}", home.indexOf("function parseRange")));
    expect(fn).toContain(': "30d"'); // fallback
    expect(fn).not.toContain(': "7d"');
  });

  it("respects every explicit URL selection (24h/7d/30d/all pass through)", () => {
    const fn = home.slice(home.indexOf("function parseRange"), home.indexOf("}", home.indexOf("function parseRange")));
    for (const r of ['"24h"', '"7d"', '"30d"', '"all"']) expect(fn).toContain(`value === ${r}`);
    expect(fn).toContain("? value"); // explicit value wins over the default
  });

  it("the chart/data pipeline receives the parsed range (single source of truth)", () => {
    expect(home).toContain("const range = parseRange(sp.range);");
    expect(home).toContain("getDashboardData(range, campaign)");
  });

  it("the switcher emits an explicit ?range= link for every option — selecting 7d/24h/all overrides the default", () => {
    const sw = read("src/components/dashboard/range-switcher.tsx");
    expect(sw).toContain("href={`${basePath}?range=${r.value}${campaignQs}`}");
    for (const r of ['"24h"', '"7d"', '"30d"', '"all"']) expect(sw).toContain(`value: ${r}`);
    // campaign filter is preserved when switching range
    expect(sw).toContain("&campaign=${campaign}");
  });

  it("does NOT change Videos or Reports defaults (intentionally separate)", () => {
    expect(read("src/app/videos/page.tsx")).toContain(': "7d"');
    expect(read("src/lib/reports.ts")).toMatch(/range:\s*"7d"/);
  });
});

// ── Behavior: KPI totals are range-independent (default change can't move them)
describe("KPI totals unaffected by the selected range", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE"]);
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01";
    process.env.BOOTCAMP_START_DATE = "2020-01-01";
  });
  afterEach(async () => {
    reset();
    restore();
    await tmp.cleanup();
  });

  it("totalViews is identical for 24h / 7d / 30d / all", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await store.insertVideo({
      campaignId: campaign.id, platform: "facebook", profileId: null,
      originalUrl: "https://www.facebook.com/reel/R1", externalVideoId: "R1",
      title: "t", caption: null, thumbnailUrl: null,
      publishedAt: "2026-07-01T00:00:00.000Z", firstTrackedAt: "2026-07-01T00:00:00.000Z",
      lastRefreshedAt: "2026-07-14T00:00:00.000Z", status: "active", episodeGroupId: null,
      sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false,
      rawJson: { source: "socialcrawl", campaign: "mtl" } as never,
    } as Parameters<typeof store.insertVideo>[0]);
    await store.addSnapshot(makeSnapshot({ videoId: v.id, capturedAt: "2026-07-14T00:00:00.000Z", views: 4321 }));

    const totals = await Promise.all(
      (["24h", "7d", "30d", "all"] as const).map(async (r) => (await getDashboardData(r, "all")).kpis.totalViews),
    );
    expect(totals).toEqual([4321, 4321, 4321, 4321]); // lifetime, not range-windowed
  });
});
