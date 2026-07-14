// Option B refresh tiers (Phase 2). Campaign assignment + video age decide how
// often a video is refreshed — and whether it is refreshed at all:
//
//   MTL Hot       MTL videos 0–HOT_VIDEO_AGE_DAYS days old   → every 15 min
//   MTL Warm      MTL videos older than that                 → every 30 min
//   Bootcamp Daily Bootcamp videos (any age)                 → once per day
//   none          excluded / removed-from-tracking           → never
//
// Unassigned-but-tracked videos default to Warm (tracked, but never hammered at
// the 15-min hot cadence). Excluded videos are tier "none" → never refreshed,
// never comment-pulled, never thumbnail-repaired, never credit-spent.
//
// Pure functions + env-read config (mirrors refresh-policy.ts). Unit-tested.

import type { CampaignSlug } from "./campaigns";
import { isAdminExcluded, videoCampaign } from "./campaigns";
import type { Video } from "./types";

export type RefreshTier = "mtl_hot" | "mtl_warm" | "bootcamp_daily" | "none";

export interface RefreshTierConfig {
  /** MTL videos at or under this age are "hot". */
  hotVideoAgeDays: number;
  /** Hot refresh cadence (minutes). */
  hotIntervalMin: number;
  /** Warm refresh cadence (minutes). */
  warmIntervalMin: number;
  /** Bootcamp refresh cadence (hours). */
  bootcampIntervalHours: number;
  /** Comment/detail pulls for Bootcamp videos (default OFF — cost control). */
  bootcampCommentDetail: boolean;
  /** Comment/detail pulls for cold/warm videos (default OFF — cost control). */
  coldCommentDetail: boolean;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function getRefreshTierConfig(): RefreshTierConfig {
  // Scaled-back defaults (July credit-contention incident): with 113 MTL + 151
  // Bootcamp videos, the old 15min/30min/24h cadences consumed the whole 350
  // SocialCrawl cap by mid-morning, starving comment pulls + discovery.
  //   hot MTL   15min → 30min
  //   warm MTL  30min → 12h
  //   Bootcamp  24h   → 72h per video (the per-post lane's stalest-first order +
  //   per-cycle limit turns this into a rolling ~50-video/day shard)
  return {
    hotVideoAgeDays: envInt("HOT_VIDEO_AGE_DAYS", 7),
    hotIntervalMin: envInt("HOT_REFRESH_INTERVAL_MINUTES", 30),
    warmIntervalMin: envInt("WARM_REFRESH_INTERVAL_MINUTES", 720),
    bootcampIntervalHours: envInt("BOOTCAMP_REFRESH_INTERVAL_HOURS", 72),
    bootcampCommentDetail: envBool("BOOTCAMP_COMMENT_DETAIL_ENABLED", false),
    coldCommentDetail: envBool("COLD_COMMENT_DETAIL_ENABLED", false),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors refresh-policy's DUE_GRACE: a tick a couple minutes shy of the
 *  interval still counts as due (the cron fires a few seconds after each tick). */
const DUE_GRACE_MIN = 2;

export interface TierInput {
  campaign: CampaignSlug | null;
  excluded: boolean;
  publishedAt: string | null;
  firstTrackedAt: string;
}

/** Age of a video in days (publishedAt preferred, else firstTrackedAt). */
export function videoAgeDays(
  v: Pick<TierInput, "publishedAt" | "firstTrackedAt">,
  now: Date,
): number {
  const postedAt = v.publishedAt ?? v.firstTrackedAt;
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return Infinity; // unknown age → treat as old (warm)
  return (now.getTime() - t) / DAY_MS;
}

/**
 * Decide a video's refresh tier from its CAMPAIGN ASSIGNMENT + age. Campaign
 * assignment is authoritative (Bootcamp stays daily even when brand new); age
 * only splits MTL into hot/warm. Excluded ⇒ "none".
 */
export function refreshTierFor(
  v: TierInput,
  now: Date = new Date(),
  cfg: RefreshTierConfig = getRefreshTierConfig(),
): RefreshTier {
  if (v.excluded) return "none";
  if (v.campaign === "bootcamp") return "bootcamp_daily";
  // MTL (or unassigned-but-tracked): age decides. Unassigned defaults to warm —
  // tracked, but never put on the 15-min hot cadence.
  if (v.campaign === "mtl") {
    return videoAgeDays(v, now) <= cfg.hotVideoAgeDays ? "mtl_hot" : "mtl_warm";
  }
  return "mtl_warm"; // unassigned (null, non-excluded)
}

/** Tier for a stored Video (derives campaign + exclusion from rawJson). */
export function videoRefreshTier(
  v: Video,
  now: Date = new Date(),
  cfg: RefreshTierConfig = getRefreshTierConfig(),
): RefreshTier {
  return refreshTierFor(
    {
      campaign: videoCampaign(v),
      excluded: isAdminExcluded(v),
      publishedAt: v.publishedAt,
      firstTrackedAt: v.firstTrackedAt,
    },
    now,
    cfg,
  );
}

/** Refresh cadence for a tier, in milliseconds (Infinity ⇒ never). */
export function tierIntervalMs(tier: RefreshTier, cfg: RefreshTierConfig): number {
  switch (tier) {
    case "mtl_hot":
      return cfg.hotIntervalMin * 60_000;
    case "mtl_warm":
      return cfg.warmIntervalMin * 60_000;
    case "bootcamp_daily":
      return cfg.bootcampIntervalHours * 3_600_000;
    case "none":
      return Infinity;
  }
}

/**
 * Is a video due for a metrics refresh now? Excluded (tier none) ⇒ never.
 * A never-refreshed video (lastRefreshedAt null) is always due. Otherwise due
 * once at least (interval − grace) has elapsed since the last refresh.
 */
export function isRefreshDue(
  v: { tier: RefreshTier; lastRefreshedAt: string | null },
  now: Date,
  cfg: RefreshTierConfig,
): boolean {
  if (v.tier === "none") return false;
  if (v.lastRefreshedAt === null) return true;
  const last = Date.parse(v.lastRefreshedAt);
  if (Number.isNaN(last)) return true;
  const interval = tierIntervalMs(v.tier, cfg);
  if (!Number.isFinite(interval)) return false;
  return now.getTime() - last >= interval - DUE_GRACE_MIN * 60_000;
}

/** Convenience for a stored Video. */
export function isVideoRefreshDue(
  v: Video,
  now: Date = new Date(),
  cfg: RefreshTierConfig = getRefreshTierConfig(),
): boolean {
  return isRefreshDue({ tier: videoRefreshTier(v, now, cfg), lastRefreshedAt: v.lastRefreshedAt }, now, cfg);
}

/** When the video is next due (admin display). null ⇒ never (excluded) or
 *  already due (never refreshed). */
export function nextRefreshDueAt(
  v: Video,
  now: Date = new Date(),
  cfg: RefreshTierConfig = getRefreshTierConfig(),
): Date | null {
  const tier = videoRefreshTier(v, now, cfg);
  if (tier === "none") return null;
  if (v.lastRefreshedAt === null) return now; // due now
  const last = Date.parse(v.lastRefreshedAt);
  if (Number.isNaN(last)) return now;
  return new Date(last + tierIntervalMs(tier, cfg));
}

/**
 * Whether comment/detail (text) pulls are allowed for this tier. Hot MTL always;
 * Bootcamp + cold/warm only when the (default-off) config flags are enabled.
 * Excluded ⇒ never.
 */
export function commentEligibleForTier(tier: RefreshTier, cfg: RefreshTierConfig): boolean {
  switch (tier) {
    case "mtl_hot":
      return true;
    case "bootcamp_daily":
      return cfg.bootcampCommentDetail;
    case "mtl_warm":
      return cfg.coldCommentDetail;
    case "none":
      return false;
  }
}

/** Human label for a tier (admin display). */
export const TIER_LABELS: Record<RefreshTier, string> = {
  mtl_hot: "MTL Hot · 15 min",
  mtl_warm: "MTL Warm · 30 min",
  bootcamp_daily: "Bootcamp · daily",
  none: "Excluded · never",
};

/** Priority order for the credit-bounded per-post DUE lane (lower = sooner).
 *  Matches the user's credit policy: warm MTL metrics before the Bootcamp batch. */
export function tierRefreshPriority(tier: RefreshTier): number {
  switch (tier) {
    case "mtl_hot":
      return 0; // (normally covered free by the profile sweep)
    case "mtl_warm":
      return 1;
    case "bootcamp_daily":
      return 2;
    case "none":
      return 99;
  }
}
