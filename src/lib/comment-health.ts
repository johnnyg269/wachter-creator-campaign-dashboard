// Read-only comment-collection health. Explains WHY comment text is or isn't
// being pulled: comment/detail pulls are limited to hot MTL videos (MTL published
// within HOT_VIDEO_AGE_DAYS) unless Bootcamp/cold comment detail is explicitly
// enabled. When MTL content ages out of "hot", the comment lane correctly finds
// zero eligible videos — this surfaces that plainly (last/next pull, eligible vs
// skipped by reason, per platform + campaign + tier). Pure reads.

import { isAdminExcluded, videoCampaign } from "./campaigns";
import { getYouTubeApiKey } from "./config";
import { eligibilityFloorForCampaign, isCampaignEligible } from "./eligibility";
import { getRefreshPolicyConfig } from "./refresh-policy";
import { commentEligibleForTier, getRefreshTierConfig, videoAgeDays, videoRefreshTier, type RefreshTier } from "./refresh-tiers";
import { getStore } from "./store";
import type { Store } from "./store/types";
import type { Platform } from "./types";

const PLATFORMS: Platform[] = ["tiktok", "instagram", "facebook", "youtube"];
const DAY = 86_400_000;

export interface CommentHealth {
  generatedAt: string;
  totals: {
    storedComments: number;
    last24h: number;
    last7d: number;
    last14d: number;
    latestPullOverall: string | null;
    latestByPlatform: Record<Platform, string | null>;
    latestByCampaign: { bootcamp: string | null; mtl: string | null };
    countByPlatform: Record<Platform, number>;
    countByCampaign: { bootcamp: number; mtl: number; excludedOrOther: number };
  };
  eligibility: {
    /** Active videos whose current tier IS comment-eligible (hot MTL by default). */
    eligibleForComments: number;
    eligibleByPlatform: Record<Platform, number>;
    /** Active videos in each tier (excluded shown separately). */
    tierCounts: Record<RefreshTier, number>;
    /** Why comment-ineligible videos are skipped. */
    skipReasons: Record<string, number>;
    /** Newest MTL video age in days — if > hotVideoAgeDays, there are no hot MTL. */
    newestMtlAgeDays: number | null;
  };
  config: {
    hotVideoAgeDays: number;
    bootcampCommentDetail: boolean;
    coldCommentDetail: boolean;
    commentPullWindowsEt: number[];
    pullsPerDay: number;
    socialcrawlDailyCreditCap: number;
    youtubeApiEnabled: boolean;
  };
  /** Plain-English explanation for the admin panel. */
  explanation: string;
}

export async function computeCommentHealth(store: Store = getStore(), now: Date = new Date()): Promise<CommentHealth> {
  const tierCfg = getRefreshTierConfig();
  const policy = getRefreshPolicyConfig();

  const videos = await store.listVideos({ includeHidden: true });
  const videoById = new Map(videos.map((v) => [v.id, v]));
  const comments = await store.listComments({ limit: 100_000 });

  const nowMs = now.getTime();
  const within = (iso: string, ms: number) => nowMs - new Date(iso).getTime() <= ms;
  const emptyPlat = <T>(val: T): Record<Platform, T> => ({ tiktok: val, instagram: val, facebook: val, youtube: val });

  // ---- comment totals ----
  const countByPlatform = emptyPlat(0);
  const latestByPlatform = emptyPlat<string | null>(null);
  const countByCampaign = { bootcamp: 0, mtl: 0, excludedOrOther: 0 };
  const latestByCampaign = { bootcamp: null as string | null, mtl: null as string | null };
  let latestPullOverall: string | null = null;
  let last24h = 0, last7d = 0, last14d = 0;
  const bump = (cur: string | null, c: string) => (cur === null || c > cur ? c : cur);
  for (const c of comments) {
    if (within(c.capturedAt, DAY)) last24h++;
    if (within(c.capturedAt, 7 * DAY)) last7d++;
    if (within(c.capturedAt, 14 * DAY)) last14d++;
    latestPullOverall = bump(latestPullOverall, c.capturedAt);
    if (PLATFORMS.includes(c.platform)) {
      countByPlatform[c.platform]++;
      latestByPlatform[c.platform] = bump(latestByPlatform[c.platform], c.capturedAt);
    }
    const v = videoById.get(c.videoId);
    const camp = v ? videoCampaign(v) : null;
    if (camp === "bootcamp") { countByCampaign.bootcamp++; latestByCampaign.bootcamp = bump(latestByCampaign.bootcamp, c.capturedAt); }
    else if (camp === "mtl") { countByCampaign.mtl++; latestByCampaign.mtl = bump(latestByCampaign.mtl, c.capturedAt); }
    else countByCampaign.excludedOrOther++;
  }

  // ---- eligibility over the ACTIVE refresh set (mirror the refresh sweep filter) ----
  const active = videos.filter(
    (v) => !v.hidden && isCampaignEligible(v, eligibilityFloorForCampaign(videoCampaign(v)), null),
  );
  const tierCounts: Record<RefreshTier, number> = { mtl_hot: 0, mtl_warm: 0, bootcamp_daily: 0, none: 0 };
  const eligibleByPlatform = emptyPlat(0);
  const skipReasons: Record<string, number> = {};
  let eligibleForComments = 0;
  let newestMtlMs: number | null = null;
  for (const v of active) {
    const tier = videoRefreshTier(v, now, tierCfg);
    tierCounts[tier]++;
    if (videoCampaign(v) === "mtl") {
      const t = Date.parse(v.publishedAt ?? v.firstTrackedAt);
      if (!Number.isNaN(t) && (newestMtlMs === null || t > newestMtlMs)) newestMtlMs = t;
    }
    if (commentEligibleForTier(tier, tierCfg)) {
      eligibleForComments++;
      if (PLATFORMS.includes(v.platform)) eligibleByPlatform[v.platform]++;
    } else {
      const reason =
        tier === "bootcamp_daily" ? "bootcamp_comments_disabled"
          : tier === "mtl_warm" ? "cold_warm_comments_disabled"
            : "excluded_or_none";
      skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    }
  }
  // Excluded (hidden) videos are never in `active`; count them explicitly as a skip class.
  const excludedCount = videos.filter((v) => isAdminExcluded(v)).length;
  if (excludedCount > 0) skipReasons["excluded_removed"] = excludedCount;

  const newestMtlAgeDays = newestMtlMs === null ? null : (nowMs - newestMtlMs) / DAY;

  const explanation =
    eligibleForComments > 0
      ? `${eligibleForComments} hot MTL video(s) are currently comment-eligible; comment text pulls run at ${policy.commentDetailWindows.join(":00, ")}:00 ET.`
      : newestMtlAgeDays !== null && newestMtlAgeDays > tierCfg.hotVideoAgeDays
        ? `No videos are currently comment-eligible. Comment text pulls are limited to HOT MTL videos (MTL published within ${tierCfg.hotVideoAgeDays} days); the newest MTL video is ${newestMtlAgeDays.toFixed(1)} days old, so all MTL content has aged out of "hot". Bootcamp (${tierCfg.bootcampCommentDetail ? "on" : "off"}) and cold/warm (${tierCfg.coldCommentDetail ? "on" : "off"}) comment detail are disabled by default for cost control. This is expected behavior, not a failure — comment counts still update with every metrics refresh.`
        : `No hot MTL videos qualify for comment text right now (cost-control gating). Comment counts still update with metrics.`;

  return {
    generatedAt: now.toISOString(),
    totals: {
      storedComments: comments.length,
      last24h, last7d, last14d,
      latestPullOverall,
      latestByPlatform,
      latestByCampaign,
      countByPlatform,
      countByCampaign,
    },
    eligibility: {
      eligibleForComments,
      eligibleByPlatform,
      tierCounts,
      skipReasons,
      newestMtlAgeDays,
    },
    config: {
      hotVideoAgeDays: tierCfg.hotVideoAgeDays,
      bootcampCommentDetail: tierCfg.bootcampCommentDetail,
      coldCommentDetail: tierCfg.coldCommentDetail,
      commentPullWindowsEt: policy.commentDetailWindows,
      pullsPerDay: policy.commentDetailWindows.length,
      socialcrawlDailyCreditCap: policy.socialcrawlDailyCreditCap,
      youtubeApiEnabled: getYouTubeApiKey() !== null,
    },
    explanation,
  };
}
