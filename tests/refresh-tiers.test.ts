// Option B refresh tiers (Phase 2): campaign + age → tier, due cadence, comment
// eligibility, and the per-post priority order. Pure functions, fixed clock.

import { afterEach, describe, expect, it } from "vitest";
import {
  commentEligibleForTier,
  getRefreshTierConfig,
  isRefreshDue,
  isVideoRefreshDue,
  nextRefreshDueAt,
  refreshTierFor,
  tierIntervalMs,
  tierRefreshPriority,
  videoRefreshTier,
  type RefreshTierConfig,
} from "@/lib/refresh-tiers";
import { makeVideo, stashEnv } from "./helpers";

const NOW = new Date("2026-06-25T12:00:00.000Z");
const CFG: RefreshTierConfig = {
  hotVideoAgeDays: 7,
  hotIntervalMin: 15,
  warmIntervalMin: 30,
  bootcampIntervalHours: 24,
  bootcampCommentDetail: false,
  coldCommentDetail: false,
};
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const minsAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();
const base = (over: Partial<{ campaign: "mtl" | "bootcamp" | null; excluded: boolean; publishedAt: string | null }>) => ({
  campaign: "campaign" in over ? (over.campaign as "mtl" | "bootcamp" | null) : "mtl",
  excluded: over.excluded ?? false,
  publishedAt: "publishedAt" in over ? (over.publishedAt as string | null) : daysAgo(2),
  firstTrackedAt: daysAgo(2),
});

describe("refreshTierFor — campaign + age decide the tier", () => {
  it("Bootcamp is daily even when the video is brand new", () => {
    expect(refreshTierFor(base({ campaign: "bootcamp", publishedAt: daysAgo(0) }), NOW, CFG)).toBe("bootcamp_daily");
    expect(refreshTierFor(base({ campaign: "bootcamp", publishedAt: daysAgo(90) }), NOW, CFG)).toBe("bootcamp_daily");
  });
  it("MTL ≤ 7 days old is hot; older is warm; exactly 7 days is still hot", () => {
    expect(refreshTierFor(base({ campaign: "mtl", publishedAt: daysAgo(2) }), NOW, CFG)).toBe("mtl_hot");
    expect(refreshTierFor(base({ campaign: "mtl", publishedAt: daysAgo(7) }), NOW, CFG)).toBe("mtl_hot");
    expect(refreshTierFor(base({ campaign: "mtl", publishedAt: daysAgo(10) }), NOW, CFG)).toBe("mtl_warm");
  });
  it("unassigned-but-tracked defaults to warm (never the 15-min hot cadence)", () => {
    expect(refreshTierFor(base({ campaign: null, publishedAt: daysAgo(1) }), NOW, CFG)).toBe("mtl_warm");
  });
  it("excluded/removed is tier none regardless of campaign or age", () => {
    expect(refreshTierFor(base({ campaign: "mtl", excluded: true, publishedAt: daysAgo(1) }), NOW, CFG)).toBe("none");
    expect(refreshTierFor(base({ campaign: "bootcamp", excluded: true }), NOW, CFG)).toBe("none");
  });
  it("missing publishedAt falls back to firstTrackedAt for age", () => {
    expect(refreshTierFor({ campaign: "mtl", excluded: false, publishedAt: null, firstTrackedAt: daysAgo(2) }, NOW, CFG)).toBe("mtl_hot");
    expect(refreshTierFor({ campaign: "mtl", excluded: false, publishedAt: null, firstTrackedAt: daysAgo(30) }, NOW, CFG)).toBe("mtl_warm");
  });
  it("truly unknown age (invalid dates) → warm, never accidentally hot", () => {
    expect(refreshTierFor({ campaign: "mtl", excluded: false, publishedAt: "garbage", firstTrackedAt: "garbage" }, NOW, CFG)).toBe("mtl_warm");
  });
});

describe("tierIntervalMs — Bootcamp is daily, never 15/30 min", () => {
  it("hot=15m, warm=30m, bootcamp=24h, none=Infinity", () => {
    expect(tierIntervalMs("mtl_hot", CFG)).toBe(15 * 60_000);
    expect(tierIntervalMs("mtl_warm", CFG)).toBe(30 * 60_000);
    expect(tierIntervalMs("bootcamp_daily", CFG)).toBe(24 * 3_600_000);
    expect(tierIntervalMs("none", CFG)).toBe(Infinity);
  });
  it("Bootcamp interval is NOT the 15-min or 30-min cadence", () => {
    const bc = tierIntervalMs("bootcamp_daily", CFG);
    expect(bc).not.toBe(tierIntervalMs("mtl_hot", CFG));
    expect(bc).not.toBe(tierIntervalMs("mtl_warm", CFG));
  });
});

describe("isRefreshDue — cadence per tier", () => {
  it("a never-refreshed video is due (except excluded)", () => {
    expect(isRefreshDue({ tier: "mtl_hot", lastRefreshedAt: null }, NOW, CFG)).toBe(true);
    expect(isRefreshDue({ tier: "bootcamp_daily", lastRefreshedAt: null }, NOW, CFG)).toBe(true);
    expect(isRefreshDue({ tier: "none", lastRefreshedAt: null }, NOW, CFG)).toBe(false);
  });
  it("hot MTL is due ~every 15 minutes", () => {
    expect(isRefreshDue({ tier: "mtl_hot", lastRefreshedAt: minsAgo(20) }, NOW, CFG)).toBe(true);
    expect(isRefreshDue({ tier: "mtl_hot", lastRefreshedAt: minsAgo(5) }, NOW, CFG)).toBe(false);
  });
  it("warm MTL is due ~every 30 minutes (NOT every 15)", () => {
    expect(isRefreshDue({ tier: "mtl_warm", lastRefreshedAt: minsAgo(35) }, NOW, CFG)).toBe(true);
    expect(isRefreshDue({ tier: "mtl_warm", lastRefreshedAt: minsAgo(15) }, NOW, CFG)).toBe(false);
  });
  it("Bootcamp is due ~once per day (NOT every 15 or 30 min)", () => {
    expect(isRefreshDue({ tier: "bootcamp_daily", lastRefreshedAt: minsAgo(15) }, NOW, CFG)).toBe(false);
    expect(isRefreshDue({ tier: "bootcamp_daily", lastRefreshedAt: minsAgo(30) }, NOW, CFG)).toBe(false);
    expect(isRefreshDue({ tier: "bootcamp_daily", lastRefreshedAt: minsAgo(60) }, NOW, CFG)).toBe(false);
    expect(isRefreshDue({ tier: "bootcamp_daily", lastRefreshedAt: minsAgo(25 * 60) }, NOW, CFG)).toBe(true);
  });
  it("excluded/removed is NEVER due (never refreshed, never spends credit)", () => {
    expect(isRefreshDue({ tier: "none", lastRefreshedAt: minsAgo(99999) }, NOW, CFG)).toBe(false);
  });
});

describe("videoRefreshTier / isVideoRefreshDue — on a stored Video (rawJson tags)", () => {
  it("reads campaign + exclusion from rawJson (migration default = MTL)", () => {
    expect(videoRefreshTier(makeVideo({ publishedAt: daysAgo(1), rawJson: null }), NOW, CFG)).toBe("mtl_hot");
    expect(videoRefreshTier(makeVideo({ publishedAt: daysAgo(1), rawJson: { campaign: "bootcamp" } as never }), NOW, CFG)).toBe("bootcamp_daily");
    expect(
      videoRefreshTier(makeVideo({ publishedAt: daysAgo(1), rawJson: { tracking: { status: "excluded" } } as never }), NOW, CFG),
    ).toBe("none");
  });
  it("an excluded video is never due", () => {
    const v = makeVideo({ publishedAt: daysAgo(1), lastRefreshedAt: daysAgo(30), rawJson: { tracking: { status: "excluded" } } as never });
    expect(isVideoRefreshDue(v, NOW, CFG)).toBe(false);
  });
});

describe("commentEligibleForTier — comments limited to hot MTL by default", () => {
  it("hot yes; bootcamp + warm/cold off by default; excluded no", () => {
    expect(commentEligibleForTier("mtl_hot", CFG)).toBe(true);
    expect(commentEligibleForTier("bootcamp_daily", CFG)).toBe(false);
    expect(commentEligibleForTier("mtl_warm", CFG)).toBe(false);
    expect(commentEligibleForTier("none", CFG)).toBe(false);
  });
  it("config flags can re-enable Bootcamp / cold comments", () => {
    expect(commentEligibleForTier("bootcamp_daily", { ...CFG, bootcampCommentDetail: true })).toBe(true);
    expect(commentEligibleForTier("mtl_warm", { ...CFG, coldCommentDetail: true })).toBe(true);
  });
});

describe("tierRefreshPriority — the credit cap prioritizes hot MTL before Bootcamp", () => {
  it("hot < warm < bootcamp < none", () => {
    expect(tierRefreshPriority("mtl_hot")).toBeLessThan(tierRefreshPriority("mtl_warm"));
    expect(tierRefreshPriority("mtl_warm")).toBeLessThan(tierRefreshPriority("bootcamp_daily"));
    expect(tierRefreshPriority("bootcamp_daily")).toBeLessThan(tierRefreshPriority("none"));
  });
});

describe("nextRefreshDueAt", () => {
  it("null for excluded; now for never-refreshed; last+interval otherwise", () => {
    expect(nextRefreshDueAt(makeVideo({ rawJson: { tracking: { status: "excluded" } } as never }), NOW, CFG)).toBeNull();
    const warm = makeVideo({ publishedAt: daysAgo(20), lastRefreshedAt: minsAgo(10), rawJson: { campaign: "mtl" } as never });
    const due = nextRefreshDueAt(warm, NOW, CFG);
    expect(due && due.getTime()).toBe(new Date(minsAgo(10)).getTime() + 30 * 60_000);
  });
});

describe("getRefreshTierConfig — env defaults", () => {
  const RESTORE = ["HOT_VIDEO_AGE_DAYS", "HOT_REFRESH_INTERVAL_MINUTES", "WARM_REFRESH_INTERVAL_MINUTES", "BOOTCAMP_REFRESH_INTERVAL_HOURS", "BOOTCAMP_COMMENT_DETAIL_ENABLED", "COLD_COMMENT_DETAIL_ENABLED"];
  let restore: () => void;
  afterEach(() => restore?.());
  it("defaults to 7d / 15m / 30m / 24h and comments off", () => {
    restore = stashEnv(RESTORE);
    const cfg = getRefreshTierConfig();
    expect(cfg).toMatchObject({
      hotVideoAgeDays: 7,
      hotIntervalMin: 15,
      warmIntervalMin: 30,
      bootcampIntervalHours: 24,
      bootcampCommentDetail: false,
      coldCommentDetail: false,
    });
  });
});
