// Admin-only manual comment catch-up: pull comment TEXT for a small, bounded set
// of comment-eligible videos on demand, so an admin can recover comments when the
// scheduled comment windows were starved of SocialCrawl budget. Defaults to fresh
// hot MTL only; Bootcamp requires an explicit campaign scope (opt-in). Never
// excluded/removed videos, never YouTube (free API lane already covers it), never
// Apify. Bounded by maxVideos AND maxCredits; logs one billable attempt per fetch.

import { isAdminExcluded, videoCampaign } from "./campaigns";
import { eligibilityFloorForCampaign, isCampaignEligible } from "./eligibility";
import { tagComment } from "./intel/keywords";
import { classifyComment } from "./intel/sentiment";
import { commentEligibleForTier, getRefreshTierConfig, videoRefreshTier } from "./refresh-tiers";
import { getStore } from "./store";
import type { Store } from "./store/types";
import type { NormalizedComment, Platform, Video } from "./types";

/** YouTube is pulled free by the Data API lane, so the catch-up is SocialCrawl-only. */
const SC_PLATFORMS: Platform[] = ["tiktok", "instagram", "facebook"];

export interface CatchupScope {
  platform?: Platform;
  /** Explicit campaign scope. Omit → default hot-MTL only. "bootcamp" is the opt-in. */
  campaign?: "mtl" | "bootcamp";
  maxVideos?: number;
  maxCredits?: number;
}

/** Comment TEXT resolver — injected so the lib is testable and provider-agnostic. */
export type CommentResolver = (platform: Platform, video: Video) => Promise<NormalizedComment[] | null>;

/** Eligible catch-up targets: SocialCrawl platform, active, not excluded, campaign-
 *  eligible. Default = comment-eligible tiers (hot MTL). An explicit campaign scope
 *  opts into that campaign's videos regardless of tier (never excluded). */
export function commentCatchupTargets(videos: Video[], scope: CatchupScope = {}, now: Date = new Date()): Video[] {
  const tierCfg = getRefreshTierConfig();
  const out = videos.filter((v) => {
    if (!SC_PLATFORMS.includes(v.platform)) return false;
    if (v.hidden || isAdminExcluded(v)) return false;
    if (!isCampaignEligible(v, eligibilityFloorForCampaign(videoCampaign(v)), null)) return false;
    if (scope.platform && v.platform !== scope.platform) return false;
    if (scope.campaign) return videoCampaign(v) === scope.campaign; // explicit opt-in scope
    return commentEligibleForTier(videoRefreshTier(v, now, tierCfg), tierCfg); // default: hot MTL
  });
  // Freshest first (newest publish), then bound by maxVideos.
  out.sort((a, b) => (b.publishedAt ?? b.firstTrackedAt).localeCompare(a.publishedAt ?? a.firstTrackedAt));
  const cap = scope.maxVideos && scope.maxVideos > 0 ? scope.maxVideos : out.length;
  return out.slice(0, cap);
}

export interface CommentCatchupResult {
  targetCount: number;
  processed: number;
  commentsFound: number;
  commentsAdded: number;
  duplicates: number;
  failed: number;
  creditsUsed: number;
  byPlatform: Record<string, { processed: number; added: number }>;
}

export async function runCommentCatchup(
  store: Store,
  deps: { resolveComments: CommentResolver; scope?: CatchupScope; now?: Date },
): Promise<CommentCatchupResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const scope = deps.scope ?? {};
  const maxCredits = scope.maxCredits && scope.maxCredits > 0 ? scope.maxCredits : Infinity;

  const targets = commentCatchupTargets(await store.listVideos({ includeHidden: true }), scope, now);
  const res: CommentCatchupResult = {
    targetCount: targets.length, processed: 0, commentsFound: 0, commentsAdded: 0,
    duplicates: 0, failed: 0, creditsUsed: 0, byPlatform: {},
  };

  for (const v of targets) {
    if (res.creditsUsed >= maxCredits) break;
    let comments: NormalizedComment[] | null = null;
    try {
      comments = await deps.resolveComments(v.platform, v);
    } catch {
      comments = null;
    }
    res.creditsUsed += 1; // one SocialCrawl comment fetch (billable, success or miss)
    res.processed += 1;
    const bp = (res.byPlatform[v.platform] ??= { processed: 0, added: 0 });
    bp.processed += 1;
    await store.addCollectionAttempt({
      refreshRunId: null,
      platform: v.platform,
      provider: "socialcrawl",
      actorId: null,
      kind: "comments",
      inputDescription: `socialcrawl ${v.platform} comment-catchup · 1cr · cache:miss${comments ? "" : " · no item"}`,
      success: Boolean(comments),
      runId: null,
      itemCount: comments?.length ?? 0,
      error: comments ? null : "no comments",
      capturedAt: nowIso,
    });
    if (!comments) {
      res.failed += 1;
      continue;
    }
    for (const c of comments) {
      res.commentsFound += 1;
      const tags = tagComment(c.text);
      const cls = classifyComment(c.text, tags);
      const { created } = await store.upsertComment({
        videoId: v.id,
        platform: v.platform,
        externalCommentId: c.externalCommentId,
        authorName: c.authorName,
        text: c.text,
        postedAt: c.postedAt,
        likes: c.likes,
        replyCount: c.replyCount,
        sentiment: cls.sentiment,
        needsResponse: cls.needsResponse,
        tags,
        permalink: c.permalink,
        capturedAt: nowIso,
        rawJson: null,
      });
      if (created) { res.commentsAdded += 1; bp.added += 1; } else res.duplicates += 1;
    }
  }
  return res;
}
