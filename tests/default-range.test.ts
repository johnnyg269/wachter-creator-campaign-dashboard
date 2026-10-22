// Homepage default time range = all. The range is URL-param driven (no
// localStorage): missing or invalid ?range= values fall back to "all",
// and every explicit selection (24h/7d/30d/all) is respected
// because the RangeSwitcher always emits explicit ?range= links. Videos and
// Reports keep their own defaults. KPI totals are lifetime values and must be
// identical across ranges (the default change cannot recalculate them).

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDashboardData } from "@/lib/queries";
import { getStore } from "@/lib/store";
import { ensureSeedData } from "@/lib/seed";
import { parseHomepageRange } from "@/lib/range";
import { parsePublicCampaignFilter } from "@/lib/campaigns";
import { PLATFORMS } from "@/lib/types";
import { useTmpCwd, stashEnv, makeSnapshot, makeVideo, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── Parser behavior + page/switcher wiring ─────────────────────────────────
describe("homepage default range", () => {
  const home = read("src/app/page.tsx");

  it("defaults to all time when no ?range= param exists", () => {
    expect(parseHomepageRange(undefined)).toBe("all");
  });

  it.each(["24h", "7d", "30d", "all"] as const)("respects explicit ?range=%s", (range) => {
    expect(parseHomepageRange(range)).toBe(range);
  });

  it.each([
    { value: "" }, { value: "invalid" }, { value: "ALL" },
    { value: ["7d", "30d"] }, { value: [] },
  ])("falls back to all time for invalid range $value", ({ value }) => {
    expect(parseHomepageRange(value)).toBe("all");
  });

  it("the chart/data pipeline receives the parsed range (single source of truth)", () => {
    expect(home).toContain("const range = parseHomepageRange(sp.range);");
    expect(home).toContain("const campaign = parsePublicCampaignFilter(sp.campaign);");
    expect(home).toContain("getDashboardData(range, campaign)");
  });

  it("the switcher emits an explicit ?range= link for every option — selecting 24h/7d/30d overrides the default", () => {
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

  it("the default includes all-time totals for both campaigns across every platform", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const oldCapture = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    let expectedTotal = 0;
    for (const slug of ["mtl", "bootcamp"] as const) {
      for (const platform of PLATFORMS) {
        const { id: _id, ...input } = makeVideo({
          campaignId: campaign.id, platform,
          originalUrl: `https://example.com/${slug}/${platform}`,
          publishedAt: oldCapture, firstTrackedAt: oldCapture,
          lastRefreshedAt: oldCapture, sourceStatus: "live",
          rawJson: { source: "socialcrawl", campaign: slug },
        });
        const video = await store.insertVideo(input);
        await store.addSnapshot(makeSnapshot({ videoId: video.id, capturedAt: oldCapture, views: 100 }));
        expectedTotal += 100;
      }
    }

    const data = await getDashboardData(parseHomepageRange(undefined), parsePublicCampaignFilter(undefined));
    expect(data.kpis.totalViews).toBe(expectedTotal);
    expect(data.campaignBreakdown.mtl.views).toBe(400);
    expect(data.campaignBreakdown.bootcamp.views).toBe(400);
    expect(data.campaignBreakdown.all.views).toBe(expectedTotal);
    for (const platform of PLATFORMS) {
      expect(data.platformStats.find((stats) => stats.platform === platform)?.views).toBe(200);
    }
    expect(data.historyStart).toBe(oldCapture);
    expect(new Date(data.trend[0].t).getTime()).toBeLessThan(Date.now() - 30 * 24 * 60 * 60 * 1000);
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
