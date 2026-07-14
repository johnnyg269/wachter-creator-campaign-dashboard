// July credit-contention regression guards: the 350 cap is partitioned into
// lanes (metrics ≤225, comments ≥75, discovery ≥25, headroom ≥25) so metrics can
// never starve comments/discovery again, and a cap-reached day still fires the
// comment windows (YouTube is free; SC lanes clamp to 0).

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { metricsBudgetFor } from "@/lib/refresh";
import { decideScheduledRefresh, getRefreshPolicyConfig } from "@/lib/refresh-policy";
import { stashEnv } from "./helpers";
import type { RefreshRun } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

describe("SocialCrawl budget lanes", () => {
  let restore: () => void;
  beforeEach(() => {
    restore = stashEnv(["SOCIALCRAWL_API_KEY", "SOCIALCRAWL_METRICS_ENABLED", "SOCIALCRAWL_DAILY_CREDIT_CAP", "SC_METRICS_DAILY_BUDGET", "REFRESH_QUIET_HOURS_ENABLED"]);
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    process.env.REFRESH_QUIET_HOURS_ENABLED = "false";
  });
  afterEach(() => restore());

  it("metrics budget: 225 of the 350 cap; admin cap override expands it above the reserves", () => {
    expect(getRefreshPolicyConfig().metricsDailyBudget).toBe(225);
    expect(metricsBudgetFor(350, 225)).toBe(225); // normal day: 225 metrics / 125 reserved
    expect(metricsBudgetFor(600, 225)).toBe(475); // today-only override: reserves preserved (125)
  });

  it("cap reached + comment window due → the run FIRES with comments on (never starved)", () => {
    const at = (etHour: number) => new Date(Date.UTC(2026, 6, 14, etHour + 4, 0, 0));
    const cfg = getRefreshPolicyConfig();
    const recentDiscovery: RefreshRun[] = [
      { id: "d", startedAt: new Date(at(11).getTime() - 30 * 60_000).toISOString(), finishedAt: null, status: "success", trigger: "cron", platformsAttempted: [], videosUpdated: 0, commentsUpdated: 0, newVideosDiscovered: 0, errors: [], rawLog: ["mode:full discovery:on comments:off"] } as unknown as RefreshRun,
    ];
    const d = decideScheduledRefresh({ now: at(12), recentRuns: recentDiscovery, todaysActorRuns: 0, todaysSocialcrawlCredits: 999, cfg });
    expect(d.action).toBe("run");
    if (d.action === "run") {
      expect(d.mode.comments).toBe(true);
      expect(d.mode.light).toBe(false);
    }
  });

  it("cap reached + discovery due → the run FIRES with discovery on (free YouTube lane)", () => {
    const at = (etHour: number) => new Date(Date.UTC(2026, 6, 14, etHour + 4, 0, 0));
    const cfg = getRefreshPolicyConfig();
    // No discovery run yet today + before the noon comment window.
    const d = decideScheduledRefresh({ now: at(9), recentRuns: [], todaysActorRuns: 0, todaysSocialcrawlCredits: 999, cfg });
    expect(d.action).toBe("run");
    if (d.action === "run") expect(d.mode.discovery).toBe(true);
  });

  it("source: per-post lane + sweep are clamped by metricsBudgetFor with distinct skip reasons", () => {
    const src = read("src/lib/refresh.ts");
    expect(src).toMatch(/metricsBudgetFor\(effectiveCreditCap, rcfg\.metricsDailyBudget\)/);
    expect(src).toMatch(/metricsBudgetReached/);
    expect(src).toMatch(/globalCapReached/);
    // The comment lane spends above the metrics budget (only the emergency
    // headroom is held back) — never the old tiny reserve.
    expect(src).toMatch(/effectiveCreditCap - usedToday - HEADROOM_RESERVE/);
  });

  it("no Apify anywhere in the scheduled lanes (kill switch intact)", () => {
    const src = read("src/lib/refresh-policy.ts");
    expect(src).not.toMatch(/api\.apify\.com/);
    const yt = read("src/lib/youtube-catchup.ts");
    // Real Apify-usage tokens only (a prose mention of the word is fine).
    expect(yt).not.toMatch(/api\.apify\.com|ApifyProvider|apify-provider|run-sync|APIFY_TOKEN/);
  });
});
