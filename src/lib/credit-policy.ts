// SocialCrawl credit policy + projection (Phase 2). Pure read-time analytics for
// the admin credit panel — never spends, never calls a provider. Credits are
// encoded in the collection-attempt log (schema-free): "<n>cr" = credits used by
// that call, "rem:<n>" = credits_remaining reported by SocialCrawl at that call.
//
// The hard daily cap (SOCIALCRAWL_DAILY_CREDIT_CAP, default 300; the campaign
// runs at 350) is enforced in refresh-policy/refresh; this module only surfaces
// usage, projection, days-remaining, the hot/warm/Bootcamp split, and the
// estimated Bootcamp import + daily-refresh costs.

import { getSocialcrawlDailyCreditCap } from "./config";
import { localDateKey, localHour, socialcrawlCreditsToday } from "./refresh-policy";
import {
  getRefreshTierConfig,
  isRefreshDue,
  refreshTierFor,
  type RefreshTier,
  type RefreshTierConfig,
} from "./refresh-tiers";
import type { CampaignSlug } from "./campaigns";
import type { Platform } from "./types";

/** Minimal attempt shape (matches CollectionAttempt + the seed log). */
export interface CreditAttempt {
  provider: string;
  inputDescription: string;
  capturedAt: string;
  success?: boolean;
}

/** SocialCrawl platforms that spend credits per call (YouTube is free quota). */
export const SOCIALCRAWL_PLATFORMS: readonly Platform[] = ["tiktok", "instagram", "facebook"];
export function isSocialcrawlPlatform(p: Platform): boolean {
  return SOCIALCRAWL_PLATFORMS.includes(p);
}

/** Most recent SocialCrawl `credits_remaining` value seen in the attempt log,
 *  or null if none recorded yet. */
export function socialcrawlCreditsRemaining(attempts: CreditAttempt[]): number | null {
  let best: { at: string; rem: number } | null = null;
  for (const a of attempts) {
    if (a.provider !== "socialcrawl") continue;
    const m = a.inputDescription.match(/rem:(\d+)/);
    if (!m) continue;
    if (!best || a.capturedAt > best.at) best = { at: a.capturedAt, rem: Number(m[1]) };
  }
  return best ? best.rem : null;
}

/** Average daily SocialCrawl credits over the last `days` COMPLETED local days
 *  (today excluded — it's still accumulating). null when no history. */
export function recentDailyAverage(
  attempts: CreditAttempt[],
  now: Date,
  tz: string,
  days = 7,
): number | null {
  const today = localDateKey(now, tz);
  const perDay = new Map<string, number>();
  for (const a of attempts) {
    if (a.provider !== "socialcrawl") continue;
    const day = localDateKey(new Date(a.capturedAt), tz);
    if (day === today) continue; // exclude the in-progress day
    const m = a.inputDescription.match(/(\d+)cr/);
    perDay.set(day, (perDay.get(day) ?? 0) + (m ? Number(m[1]) : 1));
  }
  if (perDay.size === 0) return null;
  const recent = [...perDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, days);
  const total = recent.reduce((s, [, v]) => s + v, 0);
  return total / recent.length;
}

export interface CreditSummary {
  cap: number;
  usedToday: number;
  callsToday: number;
  cachedToday: number;
  failedToday: number;
  /** Linear projection of today's spend across the active day. */
  projectedToday: number;
  remaining: number | null;
  /** Average daily spend over recent completed days (basis for days-remaining). */
  recentAvgPerDay: number | null;
  /** remaining / recentAvgPerDay (rounded down), null when unknown. */
  estDaysRemaining: number | null;
  capReached: boolean;
  /** Headroom left under today's cap (never negative). */
  headroomToday: number;
}

/**
 * Summarize SocialCrawl credit usage for the admin panel. `activeStartHour` /
 * `activeEndHour` describe the active window (default 7:00–24:00 ET) for the
 * linear day projection — quiet hours don't spend, so we extrapolate only over
 * elapsed active hours.
 */
export function summarizeCredits(args: {
  attempts: CreditAttempt[];
  now: Date;
  tz: string;
  cap?: number;
  activeStartHour?: number;
  activeEndHour?: number;
}): CreditSummary {
  const { attempts, now, tz } = args;
  const cap = args.cap ?? getSocialcrawlDailyCreditCap();
  const activeStart = args.activeStartHour ?? 0;
  const activeEnd = args.activeEndHour ?? 7; // quiet window END = active START
  const today = socialcrawlCreditsToday(attempts, now, tz);

  const h = localHour(now, tz);
  // Active hours per day = 24 minus the quiet span [activeStart, activeEnd).
  const quietSpan = activeEnd - activeStart > 0 ? activeEnd - activeStart : 7;
  const activeHoursTotal = 24 - quietSpan;
  const activeHoursSoFar = Math.max(0.5, h - activeEnd);
  const projectedToday =
    h < activeEnd ? today.credits : (today.credits / activeHoursSoFar) * activeHoursTotal;

  const remaining = socialcrawlCreditsRemaining(attempts);
  const recentAvgPerDay = recentDailyAverage(attempts, now, tz);
  const estDaysRemaining =
    remaining !== null && recentAvgPerDay !== null && recentAvgPerDay > 0
      ? Math.floor(remaining / recentAvgPerDay)
      : null;

  return {
    cap,
    usedToday: today.credits,
    callsToday: today.calls,
    cachedToday: today.cached,
    failedToday: today.failed,
    projectedToday: Math.round(projectedToday),
    remaining,
    recentAvgPerDay: recentAvgPerDay === null ? null : Math.round(recentAvgPerDay),
    estDaysRemaining,
    capReached: today.credits >= cap,
    headroomToday: Math.max(0, cap - today.credits),
  };
}

export interface TierSplit {
  counts: Record<RefreshTier, number>;
  /** SocialCrawl-billable videos per tier (excludes free YouTube). */
  socialcrawlCounts: Record<RefreshTier, number>;
  /** Estimated SocialCrawl credits for ONE full Bootcamp daily batch (1cr per
   *  SocialCrawl Bootcamp video; YouTube Bootcamp videos are free). */
  bootcampDailyRefreshCost: number;
  /** Bootcamp videos due now but not yet refreshed today (carry-over backlog). */
  bootcampPendingNow: number;
}

/** Minimal per-video shape for tier accounting (works on a stored Video or a
 *  scoped admin video whose rawJson is stripped but campaign/excluded derived). */
export interface TierVideo {
  platform: Platform;
  campaign: CampaignSlug | null;
  excluded: boolean;
  publishedAt: string | null;
  firstTrackedAt: string;
  lastRefreshedAt: string | null;
}

/**
 * Hot / Warm / Bootcamp / excluded split over a set of videos. Also estimates
 * the Bootcamp daily-refresh credit cost and the current pending backlog.
 */
export function tierSplit(
  videos: TierVideo[],
  now: Date = new Date(),
  cfg: RefreshTierConfig = getRefreshTierConfig(),
): TierSplit {
  const counts: Record<RefreshTier, number> = { mtl_hot: 0, mtl_warm: 0, bootcamp_daily: 0, none: 0 };
  const scCounts: Record<RefreshTier, number> = { mtl_hot: 0, mtl_warm: 0, bootcamp_daily: 0, none: 0 };
  let bootcampPendingNow = 0;

  for (const v of videos) {
    const tier = refreshTierFor(
      { campaign: v.campaign, excluded: v.excluded, publishedAt: v.publishedAt, firstTrackedAt: v.firstTrackedAt },
      now,
      cfg,
    );
    counts[tier]++;
    if (isSocialcrawlPlatform(v.platform)) scCounts[tier]++;
    if (tier === "bootcamp_daily" && isRefreshDue({ tier, lastRefreshedAt: v.lastRefreshedAt }, now, cfg)) {
      bootcampPendingNow++;
    }
  }

  return {
    counts,
    socialcrawlCounts: scCounts,
    bootcampDailyRefreshCost: scCounts.bootcamp_daily, // 1 credit per SC bootcamp video/day
    bootcampPendingNow,
  };
}
