// Bootcamp metrics CATCH-UP (Phase 2B follow-up). Fills the first metrics
// reading for Bootcamp videos whose metrics are still PENDING (lastRefreshedAt
// null) — e.g. imported while the SocialCrawl cap was maxed. Refreshes ONLY
// pending Bootcamp videos, via the ongoing provider (SocialCrawl TT/IG/FB,
// YouTube Data API), bounded by the active credit cap. NO comments, NO thumbnail
// repair, NO Apify, NO excluded/removed videos, NO MTL. Stops at the cap and
// leaves the remainder pending (no retry storm). Logs every billable SC call so
// the daily-cap accounting stays correct.

import type { NormalizedVideo, Platform, Video } from "./types";
import type { Store } from "./store/types";
import { isAdminExcluded, videoCampaign } from "./campaigns";
import { eligibilityFloorForCampaign, isCampaignEligible } from "./eligibility";
import { engagementRate } from "./metrics";
import { isSocialcrawlPlatform } from "./credit-policy";

export type CatchupMetricsResolver = (platform: Platform, url: string) => Promise<NormalizedVideo | null>;

interface PlatformCounts {
  pendingBefore: number;
  filled: number;
  stillPending: number;
  failed: number;
}
export interface CatchupResult {
  pendingBefore: number;
  filled: number;
  stillPending: number;
  failed: number;
  byPlatform: Record<Platform, PlatformCounts>;
  creditsUsed: number;
  capStopped: boolean;
  deadUrls: string[];
}

const emptyCounts = (): PlatformCounts => ({ pendingBefore: 0, filled: 0, stillPending: 0, failed: 0 });

/** A Bootcamp video with metrics pending = active, bootcamp-tagged, eligible,
 *  never refreshed (no snapshot yet). Excluded videos resolve to campaign null,
 *  so they're inherently excluded from this set. */
export function isPendingBootcamp(v: Video): boolean {
  if (v.hidden || isAdminExcluded(v)) return false;
  if (videoCampaign(v) !== "bootcamp") return false;
  if (v.lastRefreshedAt !== null) return false;
  return isCampaignEligible(v, eligibilityFloorForCampaign("bootcamp"), null);
}

/**
 * Fill pending Bootcamp metrics within `headroom` SocialCrawl credits (YouTube is
 * free, never gated). Processes YouTube first so it never consumes SC headroom;
 * then SocialCrawl platforms until the headroom is exhausted (rest left pending).
 */
export async function bootcampMetricsCatchup(
  store: Store,
  deps: {
    resolveMetrics: CatchupMetricsResolver;
    /** The active SocialCrawl daily cap (env default or today-only override). */
    activeCap: number;
    /**
     * LIVE total SocialCrawl credits already spent today — re-read from the shared
     * credit log before each billable call. This includes BOTH this catch-up's own
     * spend AND any concurrent scheduled-refresh spend, so the combined daily total
     * can never exceed `activeCap` (no overspend from a stale snapshot).
     */
    liveUsedToday: () => Promise<number>;
    now?: Date;
  },
): Promise<CatchupResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const activeCap = Math.max(0, Math.floor(deps.activeCap));

  const byPlatform: Record<Platform, PlatformCounts> = {
    tiktok: emptyCounts(), instagram: emptyCounts(), facebook: emptyCounts(), youtube: emptyCounts(),
  };
  const res: CatchupResult = {
    pendingBefore: 0, filled: 0, stillPending: 0, failed: 0, byPlatform,
    creditsUsed: 0, capStopped: false, deadUrls: [],
  };

  const pending = (await store.listVideos({ includeHidden: true })).filter(isPendingBootcamp);
  for (const v of pending) {
    res.pendingBefore++;
    byPlatform[v.platform].pendingBefore++;
  }
  // YouTube (free) before SocialCrawl (billable) so free fills never consume the cap.
  const ordered = [...pending].sort((a, b) => (a.platform === "youtube" ? -1 : 0) - (b.platform === "youtube" ? -1 : 0));

  for (const v of ordered) {
    const billable = isSocialcrawlPlatform(v.platform);
    if (billable) {
      // Gate on LIVE spend (shared log) — stop the moment the active cap is reached,
      // accounting for any concurrent scheduled-refresh credits. Never overspend.
      const usedNow = await deps.liveUsedToday();
      if (usedNow >= activeCap) {
        res.stillPending++;
        byPlatform[v.platform].stillPending++;
        res.capStopped = true;
        continue;
      }
    }
    let metrics: NormalizedVideo | null = null;
    try {
      metrics = await deps.resolveMetrics(v.platform, v.originalUrl);
    } catch {
      metrics = null;
    }
    if (billable) {
      res.creditsUsed += 1;
      await store.addCollectionAttempt({
        refreshRunId: null,
        platform: v.platform,
        provider: "socialcrawl",
        actorId: null,
        kind: "metrics",
        inputDescription: `socialcrawl ${v.platform} bootcamp-catchup · 1cr · cache:miss${metrics ? "" : " · no item"}`,
        success: Boolean(metrics),
        runId: null,
        itemCount: metrics ? 1 : 0,
        error: metrics ? null : "no item",
        capturedAt: nowIso,
      });
    }
    if (metrics) {
      await store.addSnapshot({
        videoId: v.id,
        capturedAt: nowIso,
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        shares: metrics.shares,
        saves: metrics.saves,
        bookmarks: metrics.bookmarks,
        engagementRate: engagementRate(metrics),
        rawJson: null,
      });
      await store.updateVideo(v.id, { lastRefreshedAt: nowIso, sourceStatus: "live", errorMessage: null });
      res.filled++;
      byPlatform[v.platform].filled++;
    } else {
      // Leave lastRefreshedAt null (still pending) on a miss — a transient provider
      // miss must not be recorded as a permanent "dead" video. The daily Bootcamp
      // tier retries it once more and advances it on a repeat miss (no retry storm:
      // daily cadence, cap-gated). Last-known-good is preserved (no write).
      res.failed++;
      byPlatform[v.platform].failed++;
      res.deadUrls.push((v.originalUrl ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 60));
    }
  }
  return res;
}
