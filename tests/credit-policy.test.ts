// SocialCrawl credit policy (Phase 2): usage/projection/remaining/days-remaining
// parsed from the attempt log, plus the hot/warm/Bootcamp tier split + Bootcamp
// daily-refresh cost. Pure functions, fixed clock + synthetic attempts.

import { describe, expect, it } from "vitest";
import {
  isSocialcrawlPlatform,
  recentDailyAverage,
  socialcrawlCreditsRemaining,
  summarizeCredits,
  tierSplit,
  type CreditAttempt,
  type TierVideo,
} from "@/lib/credit-policy";
import type { RefreshTierConfig } from "@/lib/refresh-tiers";

const TZ = "America/New_York";
const NOW = new Date("2026-06-25T17:00:00.000Z"); // 13:00 ET
const CFG: RefreshTierConfig = {
  hotVideoAgeDays: 7,
  hotIntervalMin: 15,
  warmIntervalMin: 30,
  bootcampIntervalHours: 24,
  bootcampCommentDetail: false,
  coldCommentDetail: false,
};

const att = (capturedAt: string, desc: string): CreditAttempt => ({
  provider: "socialcrawl",
  inputDescription: desc,
  capturedAt,
  success: true,
});

const ATTEMPTS: CreditAttempt[] = [
  // today (06-25): 3 + 1 = 4 credits, latest rem:17000
  att("2026-06-25T16:30:00.000Z", "socialcrawl tiktok profile · 3cr · cache:miss · rem:17005 · 10 posts"),
  att("2026-06-25T16:45:00.000Z", "socialcrawl tiktok comments · 1cr · cache:miss · rem:17000 · 5 comments"),
  // 06-24: 300 credits
  att("2026-06-24T16:00:00.000Z", "socialcrawl tiktok bulk · 300cr · cache:miss · rem:17300"),
  // 06-23: 300 credits
  att("2026-06-23T16:00:00.000Z", "socialcrawl tiktok bulk · 300cr · cache:miss · rem:17600"),
  // a YouTube/other attempt must be ignored by SocialCrawl accounting
  { provider: "youtube_api", inputDescription: "videos.list id=[5]", capturedAt: "2026-06-25T16:50:00.000Z" },
];

describe("socialcrawlCreditsRemaining", () => {
  it("returns the most recent rem: token", () => {
    expect(socialcrawlCreditsRemaining(ATTEMPTS)).toBe(17000);
  });
  it("null when no rem token recorded", () => {
    expect(socialcrawlCreditsRemaining([att("2026-06-25T10:00:00Z", "socialcrawl tiktok profile · 3cr")])).toBeNull();
  });
});

describe("recentDailyAverage — excludes the in-progress day", () => {
  it("averages prior completed days only", () => {
    expect(recentDailyAverage(ATTEMPTS, NOW, TZ)).toBe(300); // (300 + 300) / 2, today excluded
  });
  it("null with no history", () => {
    expect(recentDailyAverage([], NOW, TZ)).toBeNull();
  });
});

describe("summarizeCredits", () => {
  it("today's usage, balance, projection, and est days remaining", () => {
    const s = summarizeCredits({ attempts: ATTEMPTS, now: NOW, tz: TZ, cap: 350, activeStartHour: 0, activeEndHour: 7 });
    expect(s.usedToday).toBe(4);
    expect(s.callsToday).toBe(2);
    expect(s.cap).toBe(350);
    expect(s.remaining).toBe(17000);
    expect(s.recentAvgPerDay).toBe(300);
    expect(s.estDaysRemaining).toBe(Math.floor(17000 / 300)); // 56
    expect(s.projectedToday).toBeGreaterThanOrEqual(s.usedToday);
    expect(s.capReached).toBe(false);
    expect(s.headroomToday).toBe(346);
  });
  it("flags cap reached", () => {
    const heavy = [att("2026-06-25T16:00:00.000Z", "socialcrawl tiktok bulk · 400cr · rem:100")];
    const s = summarizeCredits({ attempts: heavy, now: NOW, tz: TZ, cap: 350 });
    expect(s.capReached).toBe(true);
    expect(s.headroomToday).toBe(0);
  });
});

describe("tierSplit", () => {
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
  const v = (over: Partial<TierVideo>): TierVideo => ({
    platform: "tiktok",
    campaign: "mtl",
    excluded: false,
    publishedAt: daysAgo(2),
    firstTrackedAt: daysAgo(2),
    lastRefreshedAt: null,
    ...over,
  });

  it("counts hot/warm/bootcamp/excluded and SC-billable Bootcamp cost", () => {
    const split = tierSplit(
      [
        v({ campaign: "mtl", publishedAt: daysAgo(1) }), // hot
        v({ campaign: "mtl", publishedAt: daysAgo(20) }), // warm
        v({ campaign: "bootcamp", platform: "tiktok" }), // bootcamp (SC)
        v({ campaign: "bootcamp", platform: "youtube" }), // bootcamp (free YT)
        v({ campaign: "mtl", excluded: true }), // none
      ],
      NOW,
      CFG,
    );
    expect(split.counts.mtl_hot).toBe(1);
    expect(split.counts.mtl_warm).toBe(1);
    expect(split.counts.bootcamp_daily).toBe(2);
    expect(split.counts.none).toBe(1);
    // Only the SocialCrawl Bootcamp video costs a credit/day (YouTube is free).
    expect(split.bootcampDailyRefreshCost).toBe(1);
    expect(split.socialcrawlCounts.bootcamp_daily).toBe(1);
  });

  it("bootcampPendingNow counts Bootcamp videos due now (never refreshed)", () => {
    const split = tierSplit(
      [
        v({ campaign: "bootcamp", lastRefreshedAt: null }), // due
        v({ campaign: "bootcamp", lastRefreshedAt: new Date(NOW.getTime() - 60_000).toISOString() }), // refreshed 1m ago → not due
      ],
      NOW,
      CFG,
    );
    expect(split.bootcampPendingNow).toBe(1);
  });
});

describe("isSocialcrawlPlatform", () => {
  it("TT/IG/FB bill credits; YouTube is free", () => {
    expect(isSocialcrawlPlatform("tiktok")).toBe(true);
    expect(isSocialcrawlPlatform("instagram")).toBe(true);
    expect(isSocialcrawlPlatform("facebook")).toBe(true);
    expect(isSocialcrawlPlatform("youtube")).toBe(false);
  });
});
