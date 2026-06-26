// The refresh pipeline. Triggered by the UI button (/api/refresh), the cron
// route (/api/cron/refresh), or scripts/refresh.ts.
//
// Per run: seed → per platform { discover → upsert videos → metrics snapshots
// → comments (tagged + classified) } → alert scan → RefreshRun record.
// Failures are isolated per platform; one broken source never blanks the rest.

import type {
  Campaign,
  NormalizedComment,
  NormalizedVideo,
  Platform,
  RefreshReport,
  RefreshRun,
  Video,
} from "./types";
import { PLATFORMS } from "./types";
import type { Store } from "./store/types";
import { ensureSeedData, effectiveStartDate } from "./seed";
import { resolveProvider } from "./providers/registry";
import { ApifyProvider } from "./providers/apify-provider";
import { isLikelyVideoItem, mergeNormalizedVideos, metricCompleteness } from "./apify/normalize";
import {
  campaignStartMs,
  classifyDiscoveryCandidate,
  eligibilityFloorForCampaign,
  isCampaignEligible,
  isReviewCandidate,
  UNASSIGNED_EPISODE_NAME,
} from "./eligibility";
import { isAdminExcluded, videoCampaign } from "./campaigns";
import {
  commentEligibleForTier,
  getRefreshTierConfig,
  isRefreshDue,
  tierRefreshPriority,
  videoRefreshTier,
} from "./refresh-tiers";
import { applyMonotonicViews, engagementRate } from "./metrics";
import { initialThumbState, mergeThumbIntoRaw, nextThumbnailState, readThumbState } from "./thumbnail-state";
import { isTikTokCdnHost } from "./thumb-proxy";
import { apifyFallbackAllowedByConfig, getApifyDailyRunCap, getApifyDailySpendCapUsd, getSocialcrawlDailyCreditCap } from "./config";
import { tagComment } from "./intel/keywords";
import { classifyComment } from "./intel/sentiment";
import { emitNewVideoAlert, emitRefreshFailureAlert, generateAlerts } from "./alerts";
import {
  decideScheduledRefresh,
  encodeRunMode,
  getRefreshPolicyConfig,
  localDateKey,
  socialcrawlCreditsToday,
  type RunMode,
} from "./refresh-policy";

const globalForRefresh = globalThis as unknown as { __wachterRefreshing?: Promise<RefreshReport> };

/**
 * Whether Apify may run RIGHT NOW: config must allow it (off by default) AND
 * today's Apify usage must be under both the run and spend caps. Off by default →
 * SocialCrawl failures preserve last-known-good instead of spending on Apify.
 */
async function apifyAllowedNow(store: Store): Promise<boolean> {
  if (!apifyFallbackAllowedByConfig()) return false;
  const cfg = getRefreshPolicyConfig();
  const today = localDateKey(new Date(), cfg.quietTimezone);
  const attempts = await store.listCollectionAttempts(500);
  const runs = attempts.filter(
    (a) => a.provider === "apify" && localDateKey(new Date(a.capturedAt), cfg.quietTimezone) === today,
  ).length;
  const spend = runs * cfg.estCostPerRunUsd;
  return runs < getApifyDailyRunCap() && spend < getApifyDailySpendCapUsd();
}

/** A crashed refresh's lock expires after this — nothing blocks forever. */
export const REFRESH_LOCK_TTL_MS = 10 * 60 * 1000;
/** SocialCrawl credits held back from the per-cycle comment budget so the
 *  metrics sweep + FB detail in the SAME run never tip over the daily cap. */
const COMMENT_CREDIT_RESERVE = 20;
/** SocialCrawl credits held back from the per-post DUE lane (Option B): leaves
 *  headroom under the daily cap for the next tick's sweep + the comment cycle. */
const PERPOST_CREDIT_RESERVE = 30;
/** Max per-post DUE fetches per platform per cycle — spreads the Bootcamp daily
 *  batch over several ticks and bounds run time well under maxDuration. */
const MAX_PERPOST_PER_CYCLE = 15;
/** Normal manual refreshes are pointless sooner than this after a success. */
export const MANUAL_FRESHNESS_WINDOW_MS = 3 * 60 * 1000;
/**
 * Scheduled (cron) refreshes skip when a success STARTED less than this long
 * ago. Measured from startedAt (the data's as-of time), not finishedAt — a
 * ~3-minute refresh finishing at :03 must not make the :05 tick skip (that
 * would silently halve the 5-minute cadence), but a 30-minute GitHub Actions
 * backup firing right after a cron-job.org run skips instead of double-
 * spending Apify credits.
 */
export const SCHEDULED_FRESHNESS_WINDOW_MS = 4 * 60 * 1000;

export type RefreshTrigger = "manual" | "cron" | "script" | "force";

export type RefreshGateDecision =
  | { action: "run"; staleRunIds: string[] }
  | { action: "skip"; kind: "locked" | "fresh"; reason: string; staleRunIds: string[] };

/**
 * Cross-process refresh gate, evaluated against persisted RefreshRuns (the
 * database is the lock — works across serverless instances and schedulers):
 *  - a "running" run younger than the TTL locks out EVERY trigger (no
 *    overlapping Apify spend, ever)
 *  - runs stuck "running" past the TTL are expired (crash recovery)
 *  - plain manual refreshes within 3 minutes of a success are skipped;
 *    scheduled (cron) refreshes skip when a success started <4 minutes ago;
 *    "force" (admin-only) bypasses freshness but never the lock
 */
export function evaluateRefreshGate(
  recentRuns: RefreshRun[],
  trigger: RefreshTrigger,
  now: Date = new Date(),
): RefreshGateDecision {
  const staleRunIds: string[] = [];
  let lock: RefreshRun | null = null;
  for (const r of recentRuns) {
    if (r.status !== "running") continue;
    const age = now.getTime() - new Date(r.startedAt).getTime();
    if (age > REFRESH_LOCK_TTL_MS) staleRunIds.push(r.id);
    else if (!lock) lock = r;
  }
  if (lock) {
    return {
      action: "skip",
      kind: "locked",
      reason: "Refresh already running, skipped.",
      staleRunIds,
    };
  }
  if (trigger === "manual" || trigger === "cron") {
    const lastSuccess = recentRuns
      .filter((r) => r.status === "success" || r.status === "partial")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (lastSuccess) {
      // Manual: measured from finish (don't let an impatient re-click burn
      // credits). Scheduled: measured from start (see constant docs above).
      const at =
        trigger === "manual"
          ? (lastSuccess.finishedAt ?? lastSuccess.startedAt)
          : lastSuccess.startedAt;
      const window =
        trigger === "manual" ? MANUAL_FRESHNESS_WINDOW_MS : SCHEDULED_FRESHNESS_WINDOW_MS;
      if (now.getTime() - new Date(at).getTime() < window) {
        return {
          action: "skip",
          kind: "fresh",
          reason: "Data refreshed recently. Next automatic refresh will run shortly.",
          staleRunIds,
        };
      }
    }
  }
  return { action: "run", staleRunIds };
}

/**
 * Single-flight entry point. A second trigger while one is running on the
 * SAME instance returns a fast "skipped" report (consistent with the
 * database gate that covers cross-instance overlap) instead of hanging the
 * caller until the in-flight refresh finishes.
 */
/** Admin manual-refresh lanes: metrics-only (no import), discovery (metrics +
 *  find new posts), or full (metrics + discovery + comment detail). */
export type RefreshModeName = "metrics" | "discovery" | "full";

export function runRefresh(
  trigger: RefreshTrigger,
  opts: { force?: boolean; mode?: RefreshModeName } = {},
): Promise<RefreshReport> {
  if (globalForRefresh.__wachterRefreshing) {
    const now = new Date().toISOString();
    return Promise.resolve({
      runId: "in-flight",
      startedAt: now,
      finishedAt: now,
      status: "skipped",
      skipReason: "Refresh already running, skipped.",
      platforms: [],
      errors: [],
    });
  }
  const effective: RefreshTrigger = opts.force && trigger === "manual" ? "force" : trigger;
  const p = doRefresh(effective, opts.mode).finally(() => {
    globalForRefresh.__wachterRefreshing = undefined;
  });
  globalForRefresh.__wachterRefreshing = p;
  return p;
}

async function recordSkip(
  store: Store,
  trigger: RefreshTrigger,
  decision: { kind: string; reason: string },
): Promise<RefreshReport> {
  const now = new Date().toISOString();
  const run = await store.createRefreshRun({
    startedAt: now,
    finishedAt: now,
    status: "skipped",
    trigger,
    platformsAttempted: [],
    videosUpdated: 0,
    commentsUpdated: 0,
    newVideosDiscovered: 0,
    errors: [],
    rawLog: [`skipped (${decision.kind}): ${decision.reason}`],
  });
  return {
    runId: run.id,
    startedAt: now,
    finishedAt: now,
    status: "skipped",
    skipReason: decision.reason,
    platforms: [],
    errors: [],
  };
}

async function doRefresh(
  trigger: RefreshTrigger,
  modeOverride?: RefreshModeName,
): Promise<RefreshReport> {
  const { getStore } = await import("./store");
  const store = getStore();
  const campaign = await ensureSeedData(store);
  const startedAt = new Date().toISOString();
  const log: string[] = [];
  // Effective SocialCrawl cap = a today-only admin override if active, else the
  // env default. Threaded into the cron policy + the per-post/comment budgets so
  // the whole run honors one cap (auto-reverts when the override expires).
  const { resolveCreditCap } = await import("./credit-cap");
  const effectiveCreditCap = (await resolveCreditCap(store, new Date())).activeCap;

  // ── Refresh gate: expire crashed locks, then lock/freshness check ────────
  const recent = await store.listRefreshRuns(10);
  const decision = evaluateRefreshGate(recent, trigger);
  for (const id of decision.staleRunIds) {
    await store.updateRefreshRun(id, {
      status: "failed",
      finishedAt: startedAt,
      errors: ["Refresh lock expired — run assumed crashed"],
    });
  }
  if (decision.action === "skip") {
    return recordSkip(store, trigger, decision);
  }

  // ── Cost-control policy (scheduled runs only): quiet hours, budget cap,
  // and tiered cadences. Manual/force/script bypass policy, never the lock.
  let mode: RunMode = { light: false, discovery: true, comments: true };
  if (modeOverride && trigger !== "cron") {
    // Admin chose an explicit lane (metrics / discovery / full).
    mode =
      modeOverride === "metrics"
        ? { light: false, discovery: false, comments: false }
        : modeOverride === "discovery"
          ? { light: false, discovery: true, comments: false }
          : { light: false, discovery: true, comments: true };
  }
  if (trigger === "cron") {
    const cfg = getRefreshPolicyConfig();
    cfg.socialcrawlDailyCreditCap = effectiveCreditCap; // honor today-only override
    const attempts = await store.listCollectionAttempts(500);
    const nowD = new Date();
    const todayKey = localDateKey(nowD, cfg.quietTimezone);
    const todaysActorRuns = attempts.filter(
      (a) =>
        a.provider === "apify" &&
        localDateKey(new Date(a.capturedAt), cfg.quietTimezone) === todayKey,
    ).length;
    const todaysSocialcrawlCredits = socialcrawlCreditsToday(attempts, nowD, cfg.quietTimezone).credits;
    const policy = decideScheduledRefresh({
      recentRuns: await store.listRefreshRuns(60),
      todaysActorRuns,
      todaysSocialcrawlCredits,
      cfg,
    });
    if (policy.action === "skip") {
      return recordSkip(store, trigger, { kind: policy.kind, reason: policy.reason });
    }
    mode = policy.mode;
    log.push(`policy: ${policy.reason}`);
  }
  // First log entry encodes the mode — the policy layer parses this from
  // RefreshRun.rawLog to know when discovery/comments last ran.
  log.unshift(encodeRunMode(mode));

  const run = await store.createRefreshRun({
    startedAt,
    finishedAt: null,
    status: "running",
    trigger,
    platformsAttempted: [],
    videosUpdated: 0,
    commentsUpdated: 0,
    newVideosDiscovered: 0,
    errors: [],
    rawLog: null,
  });

  // Optimistic double-check: if another instance created a running run just
  // before ours, the OLDER one wins and we bow out as skipped.
  const concurrent = (await store.listRefreshRuns(10)).find(
    (r) =>
      r.id !== run.id &&
      r.status === "running" &&
      r.startedAt <= run.startedAt &&
      new Date(startedAt).getTime() - new Date(r.startedAt).getTime() < REFRESH_LOCK_TTL_MS,
  );
  if (concurrent) {
    await store.updateRefreshRun(run.id, {
      status: "skipped",
      finishedAt: new Date().toISOString(),
      rawLog: ["skipped (locked): lost start race to a concurrent refresh"],
    });
    return {
      runId: run.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "skipped",
      skipReason: "Refresh already running, skipped.",
      platforms: [],
      errors: [],
    };
  }

  const report: RefreshReport = {
    runId: run.id,
    startedAt,
    finishedAt: startedAt,
    status: "success",
    platforms: [],
    errors: [],
  };

  const apifyAllowed = await apifyAllowedNow(store);
  // Option B cadence gating applies to SCHEDULED (cron) runs only. Manual /
  // force / script refreshes snapshot every matched video immediately (the
  // profile sweep is free) — the per-post DUE lane still respects the tier
  // cadence + credit cap on every trigger so a manual click can't overspend.
  const respectTiers = trigger === "cron";
  for (const platform of PLATFORMS) {
    const platformReport = await refreshPlatform(store, campaign, platform, log, run.id, mode, apifyAllowed, respectTiers, effectiveCreditCap);
    report.platforms.push(platformReport);
    if (platformReport.status === "failed" && platformReport.reason) {
      report.errors.push(`${platform}: ${platformReport.reason}`);
      await emitRefreshFailureAlert(store, campaign, platform, platformReport.reason);
    }
  }

  try {
    const alertCount = await generateAlerts(store, campaign);
    log.push(`alert scan created ${alertCount} alert(s)`);
  } catch (e) {
    report.errors.push(`alert scan: ${String(e)}`);
  }

  const attempted = report.platforms.filter((p) => p.status !== "skipped");
  const failed = report.platforms.filter((p) => p.status === "failed");
  const partial = report.platforms.filter((p) => p.status === "partial");
  report.status =
    attempted.length === 0
      ? "partial"
      : failed.length === attempted.length
        ? "failed"
        : failed.length === 0 && partial.length === 0
          ? "success"
          : "partial";
  report.finishedAt = new Date().toISOString();

  await store.updateRefreshRun(run.id, {
    finishedAt: report.finishedAt,
    status: report.status,
    platformsAttempted: attempted.map((p) => p.platform),
    videosUpdated: report.platforms.reduce((s, p) => s + p.videosUpdated, 0),
    commentsUpdated: report.platforms.reduce((s, p) => s + p.commentsUpdated, 0),
    newVideosDiscovered: report.platforms.reduce((s, p) => s + p.newVideosDiscovered, 0),
    errors: report.errors,
    rawLog: log.slice(0, 200),
  });

  return report;
}

/**
 * Hot-video subset for light refreshes: top-6 by latest confirmed views,
 * anything posted in the last 24h. Cold/warm videos wait for the next full.
 */
async function pickHotVideos(store: Store, videos: Video[]): Promise<Video[]> {
  const latestViews = new Map<string, number>();
  for (const v of videos) {
    const snaps = await store.listSnapshots(v.id);
    const confirmed = snaps
      .filter((sn) => sn.views !== null)
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
    if (confirmed?.views !== null && confirmed !== undefined) {
      latestViews.set(v.id, confirmed.views as number);
    }
  }
  const topIds = new Set(
    [...latestViews.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([id]) => id),
  );
  const now = Date.now();
  return videos.filter((v) => {
    if (topIds.has(v.id)) return true;
    const postedAt = v.publishedAt ?? v.firstTrackedAt;
    return now - new Date(postedAt).getTime() <= 24 * 3_600_000;
  });
}

async function refreshPlatform(
  store: Store,
  campaign: Campaign,
  platform: Platform,
  log: string[],
  refreshRunId: string,
  mode: RunMode = { light: false, discovery: true, comments: true },
  apifyAllowed = false,
  respectTiers = false,
  effectiveCreditCap = getSocialcrawlDailyCreditCap(),
): Promise<RefreshReport["platforms"][number]> {
  const out: RefreshReport["platforms"][number] = {
    platform,
    providerType: null,
    status: "ok",
    reason: null,
    videosUpdated: 0,
    commentsUpdated: 0,
    newVideosDiscovered: 0,
  };

  const { provider, readiness, config } = await resolveProvider(platform, store, apifyAllowed);
  out.providerType = provider.providerType;

  const profiles = (await store.listProfiles()).filter((p) => p.platform === platform);
  const profile = profiles[0] ?? null;
  // Eligible tracked campaign videos only. Quarantined / out-of-campaign records
  // (e.g. old profile-feed imports with epoch dates) are excluded so refresh
  // never re-snapshots them and never treats them as tracked.
  const startMs = campaignStartMs();
  const episodeGroups = await store.listEpisodeGroups();
  const unassignedId = episodeGroups.find((e) => e.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;
  const videos = (await store.listVideos({ platform, includeHidden: true }))
    .filter((v) => !v.hidden)
    // Campaign-aware floor: Bootcamp-tagged videos are eligible back to the
    // Bootcamp start (April), so they refresh; MTL/untagged use the MTL floor.
    .filter((v) => isCampaignEligible(v, eligibilityFloorForCampaign(videoCampaign(v)), unassignedId));

  if (!readiness.ready) {
    out.status = "skipped";
    out.reason = readiness.detail ?? readiness.sourceStatus;
    // Keep per-video source status honest while the platform is unconnected.
    for (const v of videos) {
      if (v.sourceStatus !== readiness.sourceStatus && v.lastRefreshedAt === null) {
        await store.updateVideo(v.id, { sourceStatus: readiness.sourceStatus });
      }
    }
    if (profile && profile.status !== readiness.sourceStatus) {
      await store.updateProfile(profile.id, { status: readiness.sourceStatus });
    }
    log.push(`${platform}: skipped (${out.reason})`);
    return out;
  }

  const since = effectiveStartDate(campaign);

  // Cost policy shaping:
  //  - light mode: hot videos only via the direct-URL surface. YouTube's
  //    channel sweep AND Facebook's profile-FEED sweep ARE their only
  //    view-bearing metrics fetch (the direct reel page has no views on
  //    either), so both sit light cycles out entirely.
  //  - discovery off: drop the profile sweep where the direct-URL surface can
  //    cover metrics (TikTok/Instagram) — no new-post hunting. YouTube and
  //    Facebook keep their sweep because it is the metrics source itself.
  //    EXCEPTION: SocialCrawl's profile endpoint IS its metrics source (there is
  //    no cheap per-video surface), so it must always fetch the profile — the
  //    metrics-vs-discovery distinction is whether unmatched items get added.
  const profileIsMetricsSource =
    provider.providerType === "socialcrawl" || platform === "youtube" || platform === "facebook";
  let targetVideos = videos;
  let targetProfile: typeof profile | null = profile;
  if (mode.light) {
    if (platform === "youtube" || platform === "facebook") {
      out.status = "skipped";
      out.reason = `light refresh — ${platform === "youtube" ? "channel" : "feed"} sweep deferred to the next full refresh`;
      log.push(`${platform}: ${out.reason}`);
      return out;
    }
    targetProfile = null;
    targetVideos = await pickHotVideos(store, videos);
    if (targetVideos.length === 0) {
      out.status = "skipped";
      out.reason = "light refresh — no hot videos to update";
      log.push(`${platform}: ${out.reason}`);
      return out;
    }
    log.push(`${platform}: light refresh targeting ${targetVideos.length} hot video(s)`);
  } else if (!mode.discovery && !profileIsMetricsSource) {
    targetProfile = null;
    log.push(`${platform}: discovery sweep skipped this cycle (not due)`);
  }

  try {
    let fetched: {
      videos: NormalizedVideo[];
      commentsByVideo: Record<string, NormalizedComment[]>;
      attempts: import("./providers/types").AttemptDraft[];
    };
    if (provider.fetchPlatform) {
      // wantComments is the cost lever: comment detail (text) is pulled only on
      // the once-per-day comment cycle; metric-only refreshes skip the comment
      // add-ons entirely. Comment COUNTS still arrive with the cheap metric item.
      //
      // In-run credit budget: cap the number of per-video comment fetches at the
      // SocialCrawl credit headroom remaining today (minus a small reserve), so a
      // single comment cycle can never overshoot the daily cap mid-run. Recomputed
      // per platform from persisted attempts, so earlier platforms in this run
      // count. Only meaningful for the SocialCrawl provider (YouTube is free).
      let commentBudget: number | undefined;
      if (mode.comments && provider.providerType === "socialcrawl") {
        const rcfg = getRefreshPolicyConfig();
        const usedToday = socialcrawlCreditsToday(
          await store.listCollectionAttempts(1000),
          new Date(),
          rcfg.quietTimezone,
        ).credits;
        commentBudget = Math.max(0, effectiveCreditCap - usedToday - COMMENT_CREDIT_RESERVE);
      }
      // Option B (Part 10): comment/detail (text + per-post engagement) pulls are
      // limited to the hot-MTL subset — Bootcamp + cold/warm are off by default
      // (config-gated). Removed videos are never in targetVideos. Metrics for the
      // rest still come from the cheap profile sweep.
      const tierCfg = getRefreshTierConfig();
      const nowForComments = new Date();
      const commentTargets = mode.comments
        ? targetVideos.filter((v) =>
            commentEligibleForTier(videoRefreshTier(v, nowForComments, tierCfg), tierCfg),
          )
        : [];
      fetched = await provider.fetchPlatform(targetProfile, targetVideos, since, {
        wantComments: mode.comments,
        commentBudget,
        commentTargets,
      });
    } else {
      // Per-video fallback path for providers without a batch implementation.
      fetched = { videos: [], commentsByVideo: {}, attempts: [] };
      for (const v of videos) {
        const n = await provider.getVideoMetrics(v);
        if (n) fetched.videos.push(n);
        if (provider.supportsComments) {
          const comments = await provider.getVideoComments(v);
          if (comments.length > 0) {
            fetched.commentsByVideo[n?.externalVideoId ?? v.originalUrl] = comments;
          }
        }
      }
      if (profile && provider.supportsDiscovery) {
        const discovered = await provider.discoverNewVideos(profile, since);
        fetched.videos.push(...discovered);
      }
    }

    // Persist the attempt log (success and failure alike) so admin can see
    // exactly which sources were tried.
    for (const a of fetched.attempts) {
      await store.addCollectionAttempt({
        refreshRunId,
        platform,
        provider: a.provider,
        actorId: a.actorId,
        kind: a.kind,
        inputDescription: a.inputDescription,
        success: a.success,
        runId: a.runId,
        itemCount: a.itemCount,
        error: a.error,
        capturedAt: new Date().toISOString(),
      });
    }

    const capturedAt = new Date().toISOString();

    // Comment TEXT upsert — decoupled from the metrics sweep. The provider
    // fetched comments per TRACKED video (keyed by externalVideoId ?? originalUrl),
    // so we drain that map over the SAME tracked set. This runs BEFORE the
    // empty-cycle guard and independent of `groups`, so comments are never
    // dropped for videos outside the profile window (e.g. older Facebook reels)
    // or when the metrics sweep returns nothing. Dedup is by stable comment id
    // in the store; an empty/failed pull adds nothing (never wipes last-known-good).
    if (mode.comments) {
      for (const v of targetVideos) {
        const key = v.externalVideoId ?? v.originalUrl ?? "";
        const comments = key ? (fetched.commentsByVideo[key] ?? []) : [];
        for (const c of comments) {
          const tags = tagComment(c.text);
          const cls = classifyComment(c.text, tags);
          const { created } = await store.upsertComment({
            videoId: v.id,
            platform,
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
            capturedAt,
            rawJson: null,
          });
          if (created) out.commentsUpdated++;
        }
      }
    }

    // Group fetched records by the tracked video they resolve to and merge —
    // one snapshot per video per refresh, never a views-less duplicate
    // clobbering a surface that did expose views.
    //
    // METRICS lane (always): a provider profile sweep returns the creator's
    // WHOLE recent feed; we update metrics ONLY for already-tracked, eligible
    // videos. DISCOVERY lane (mode.discovery): unmatched items from the known
    // campaign profile are classified — recent eligible posts are AUTO-ADDED,
    // after-start-but-uncertain posts go to the admin review queue, and
    // old/invalid/pre-campaign posts are ignored. Without discovery, unmatched
    // items are simply ignored (never the over-import that corrupted totals).
    const eligibleTrackedIds = new Set(videos.map((v) => v.id));
    const lookbackMs = getRefreshPolicyConfig().discoveryLookbackHours * 60 * 60 * 1000;
    const nowMs = Date.now();
    let unmatchedIgnored = 0;
    const disc = { added: 0, review: 0, ignored: 0, healed: 0, reasons: {} as Record<string, number> };
    const seenNew = new Set<string>();
    const groups = new Map<string, { merged: NormalizedVideo; commentKeys: Set<string> }>();
    // Videos created or healed THIS cycle always get a snapshot, bypassing the
    // tier cadence gate (a brand-new record must record its first data point).
    const forcedIds = new Set<string>();
    const addToGroup = (gkey: string, n: NormalizedVideo) => {
      const commentKey = n.externalVideoId ?? n.originalUrl ?? "";
      const group = groups.get(gkey);
      if (!group) {
        groups.set(gkey, { merged: n, commentKeys: new Set([commentKey]) });
      } else {
        group.merged =
          metricCompleteness(n) > metricCompleteness(group.merged)
            ? mergeNormalizedVideos(n, group.merged)
            : mergeNormalizedVideos(group.merged, n);
        group.commentKeys.add(commentKey);
      }
    };
    for (const n of fetched.videos) {
      const existing = await store.findVideoByUrlOrExternalId(
        platform,
        n.originalUrl,
        n.externalVideoId,
      );
      if (existing) {
        if (eligibleTrackedIds.has(existing.id)) {
          addToGroup(`v:${existing.id}`, n); // tracked + eligible → metrics update
        } else {
          // Tracked but currently EXCLUDED (corrupt/Jan-1970 date, admin-hidden,
          // or a pending review candidate). If the provider now confirms a valid
          // eligible date, HEAL it (fix date, un-hide, clear review flag) so a
          // real campaign video stops being invisible — this is why a record can
          // be "already tracked" yet absent from every view. Genuine pre-campaign
          // / ineligible content stays excluded.
          const nInput = {
            platform,
            originalUrl: n.originalUrl,
            publishedAt: n.publishedAt,
            isSeed: false,
            episodeGroupId: null as string | null,
          };
          const canHeal = isAdminExcluded(existing)
            ? // Admin DELIBERATELY removed this from tracking — never auto-heal /
              // re-add it via discovery; only an admin Restore brings it back.
              false
            : isReviewCandidate(existing)
              ? // a review candidate only auto-promotes once it clearly qualifies for auto-add (<=72h)
                classifyDiscoveryCandidate(
                  { platform, originalUrl: n.originalUrl, externalVideoId: n.externalVideoId, publishedAt: n.publishedAt },
                  { startMs, lookbackMs, now: nowMs },
                ).decision === "add"
              : // any other excluded record heals on a valid eligible provider date
                // (campaign-aware floor: a Bootcamp-tagged record heals back to April)
                isCampaignEligible(nInput, eligibilityFloorForCampaign(videoCampaign(existing)), null);
          if (canHeal) {
            await healExistingVideo(store, existing, n);
            disc.healed++;
            forcedIds.add(existing.id);
            addToGroup(`v:${existing.id}`, n);
          } else {
            unmatchedIgnored++;
          }
        }
        continue;
      }
      // Unmatched (not yet tracked).
      if (!mode.discovery) {
        unmatchedIgnored++; // metrics-only lane never imports
        continue;
      }
      const key = n.externalVideoId ?? n.originalUrl ?? "";
      if (key && seenNew.has(key)) continue;
      if (key) seenNew.add(key);
      const cls = classifyDiscoveryCandidate(
        { platform, originalUrl: n.originalUrl, externalVideoId: n.externalVideoId, publishedAt: n.publishedAt },
        { startMs, lookbackMs, now: nowMs },
      );
      if (cls.decision === "ignore") {
        disc.ignored++;
        disc.reasons[cls.reason] = (disc.reasons[cls.reason] ?? 0) + 1;
      } else if (cls.decision === "add") {
        const created = await insertDiscoveredVideo(store, campaign, platform, profile?.id ?? null, n, false);
        disc.added++;
        out.newVideosDiscovered++;
        await emitNewVideoAlert(store, campaign, created);
        forcedIds.add(created.id);
        addToGroup(`v:${created.id}`, n); // snapshot now so it counts immediately
      } else {
        // review: persisted hidden + flagged → never counted until an admin promotes it.
        await insertDiscoveredVideo(store, campaign, platform, profile?.id ?? null, n, true, cls.reason);
        disc.review++;
        disc.reasons[cls.reason] = (disc.reasons[cls.reason] ?? 0) + 1;
      }
    }
    if (mode.discovery) {
      const reasons = Object.entries(disc.reasons).map(([k, v]) => `${k}=${v}`).join(",");
      log.push(
        `${platform}: discovery — added:${disc.added} review:${disc.review} ignored:${disc.ignored} healed:${disc.healed}` +
          (reasons ? ` · ${reasons}` : ""),
      );
    } else if (disc.healed > 0) {
      log.push(`${platform}: healed ${disc.healed} stale/excluded record(s) with a valid provider date`);
    }
    if (unmatchedIgnored > 0) {
      log.push(
        `${platform}: ignored ${unmatchedIgnored} unmatched item(s) (tracked-only / not eligible)`,
      );
    }

    // Empty-cycle protection. Facebook's actor alternates between a feed
    // surface (carries views) and a reel-page surface (no usable records);
    // some cycles return zero usable items even though the videos still exist
    // and are healthy. Treat that as "partial — kept last-known-good", NOT a
    // success that records a fresh timestamp and NOT a failure that wipes data.
    // Only guards when we actually have tracked videos to protect.
    if (groups.size === 0 && videos.length > 0) {
      out.status = "partial";
      out.reason = "Source returned no usable records this cycle — kept last-known-good data.";
      log.push(
        `${platform}: partial — 0 usable records returned, preserved ${videos.length} last-known-good video(s)`,
      );
      return out;
    }

    // Snapshot each matched video — but on a SCHEDULED (cron) run, only when DUE
    // per its Option B tier (hot MTL every 15m, warm MTL every 30m, Bootcamp
    // daily). Not-due videos carry their last-known-good forward (no snapshot,
    // no timestamp bump → no artificial chart dip). Freshly created/healed
    // records always snapshot. Manual/force runs (respectTiers=false) snapshot
    // everything — the profile sweep is already free.
    const tierCfgSnap = getRefreshTierConfig();
    const snapNow = new Date();
    let deferredNotDue = 0;
    for (const [gkey, grp] of groups) {
      const id = gkey.startsWith("v:") ? gkey.slice(2) : null;
      const before = id ? await store.getVideo(id) : null;
      let due = (id !== null && forcedIds.has(id)) || !respectTiers || before === null;
      if (!due && before) {
        const tier = videoRefreshTier(before, snapNow, tierCfgSnap);
        due = tier !== "none" && isRefreshDue({ tier, lastRefreshedAt: before.lastRefreshedAt }, snapNow, tierCfgSnap);
      }
      if (!due) {
        deferredNotDue++;
        continue;
      }
      const video = await upsertFetchedVideo(store, campaign, platform, profile?.id ?? null, grp.merged, out, mode.discovery);
      if (!video) continue;
      await writeMetricsSnapshot(store, video, grp.merged, capturedAt, log, platform);
      out.videosUpdated++;
    }
    if (deferredNotDue > 0) {
      log.push(
        `${platform}: ${deferredNotDue} matched video(s) not due this tier cycle — carried last-known-good forward`,
      );
    }

    // Tracked videos absent from this cycle's provider response keep their
    // last-known-good (no snapshot is written, the chart carries it forward) —
    // surface the count so admin can see when the source returned a partial set
    // (e.g. SocialCrawl's Facebook profile endpoint only lists the ~10 most
    // recent reels). This never zeroes or drops anything.
    const matchedIds = new Set([...groups.keys()].map((k) => k.replace(/^v:/, "")));
    // Only meaningful on a full profile sweep — a light cycle deliberately
    // targets a hot subset, so "missing" there is expected, not a partial set.
    const missingFromProvider = mode.light ? [] : videos.filter((v) => !matchedIds.has(v.id));
    if (missingFromProvider.length > 0) {
      log.push(
        `${platform}: ${missingFromProvider.length} tracked video(s) not in this cycle's response — kept last-known-good (carried forward)`,
      );
    }

    // ── Option B per-post DUE lane ───────────────────────────────────────────
    // Refresh tracked videos the cheap profile sweep did NOT return (older than
    // the ~10-item window) — but ONLY when DUE per their tier and WITHIN the
    // SocialCrawl daily credit cap. This is where the Bootcamp daily batch + warm
    // MTL beyond the window actually spend credits. Priority: warm MTL before the
    // Bootcamp batch. Excluded videos are already absent from `videos` (and tier
    // "none" is filtered) so they never spend a credit. YouTube fetches by id for
    // free (no credit gate). Whatever doesn't fit the cap/cycle carries to the
    // next run — lastRefreshedAt only advances for videos actually fetched.
    const perPostProcessedIds = new Set<string>();
    if (!mode.light && provider.getVideoMetadata && missingFromProvider.length > 0) {
      const cfgTier = getRefreshTierConfig();
      const nowPP = new Date();
      const isSc = provider.providerType === "socialcrawl";
      const due = missingFromProvider
        .map((v) => ({ v, tier: videoRefreshTier(v, nowPP, cfgTier) }))
        .filter((x) => x.tier !== "none")
        .filter((x) => isRefreshDue({ tier: x.tier, lastRefreshedAt: x.v.lastRefreshedAt }, nowPP, cfgTier))
        .sort(
          (a, b) =>
            tierRefreshPriority(a.tier) - tierRefreshPriority(b.tier) ||
            (a.v.lastRefreshedAt ?? "").localeCompare(b.v.lastRefreshedAt ?? ""),
        );
      let headroom = Infinity;
      if (isSc) {
        const rcfg = getRefreshPolicyConfig();
        const usedToday = socialcrawlCreditsToday(
          await store.listCollectionAttempts(1000),
          nowPP,
          rcfg.quietTimezone,
        ).credits;
        headroom = Math.max(0, effectiveCreditCap - usedToday - PERPOST_CREDIT_RESERVE);
      }
      const limit = Math.min(due.length, MAX_PERPOST_PER_CYCLE, isSc ? headroom : Infinity);
      let processed = 0;
      for (const { v, tier } of due) {
        if (processed >= limit) break;
        const at = new Date().toISOString();
        let detail: NormalizedVideo | null = null;
        try {
          detail = await provider.getVideoMetadata(v.originalUrl);
        } catch {
          detail = null;
        }
        if (detail) {
          const video = await upsertFetchedVideo(store, campaign, platform, profile?.id ?? null, detail, out, false);
          if (video) {
            await writeMetricsSnapshot(store, video, detail, capturedAt, log, platform);
            out.videosUpdated++;
          } else {
            await store.updateVideo(v.id, { lastRefreshedAt: at });
          }
        } else {
          // Miss (deleted/private/no item): advance the timestamp so we don't
          // re-spend a credit on this video until its next tier interval.
          await store.updateVideo(v.id, { lastRefreshedAt: at });
        }
        perPostProcessedIds.add(v.id);
        if (isSc) {
          await store.addCollectionAttempt({
            refreshRunId,
            platform,
            provider: "socialcrawl",
            actorId: null,
            kind: "metrics",
            inputDescription: `socialcrawl ${platform} due-refresh ${tier} · 1cr · cache:miss${detail ? "" : " · no item"}`,
            success: Boolean(detail),
            runId: null,
            itemCount: detail ? 1 : 0,
            error: detail ? null : "no item in detail response",
            capturedAt: at,
          });
        }
        processed++;
      }
      const remaining = due.length - processed;
      if (processed > 0 || remaining > 0) {
        log.push(
          `${platform}: per-post due refresh — ${processed} updated` +
            (remaining > 0
              ? `, ${remaining} carried to next cycle (${isSc ? `credit headroom ${Math.round(headroom)}` : "per-cycle limit"})`
              : ""),
        );
      }
    }

    // Facebook thumbnail repair: the profile reels endpoint lists only the most
    // recent ~10 reels, so older tracked reels can lack a cover. On DISCOVERY
    // cycles only (never every 15-min metrics pull), fetch /facebook/post for a
    // small, capped batch of active FB videos that still have no thumbnail —
    // SocialCrawl only (NEVER Apify), bounded by MAX_THUMBNAIL_RETRIES so it
    // never retries forever, and it never overwrites a good/last-known-good
    // thumbnail (nextThumbnailState preserves those). The scheduler's daily
    // credit cap stops the whole refresh before this runs when the cap is hit.
    if (
      platform === "facebook" &&
      mode.discovery &&
      provider.providerType !== "apify" &&
      provider.getVideoMetadata
    ) {
      const MAX_FB_THUMB_REPAIR_PER_CYCLE = 5;
      const needRepair = missingFromProvider
        .filter((v) => !perPostProcessedIds.has(v.id)) // per-post lane already refreshed (incl. thumbnail)
        .filter((v) => !v.thumbnailUrl)
        .filter((v) => readThumbState(v.rawJson).status !== "failed")
        .slice(0, MAX_FB_THUMB_REPAIR_PER_CYCLE);
      let repaired = 0;
      for (const v of needRepair) {
        const now2 = new Date().toISOString();
        let detail: NormalizedVideo | null = null;
        try {
          detail = await provider.getVideoMetadata(v.originalUrl);
        } catch {
          detail = null;
        }
        const ts = nextThumbnailState({
          resolvedUrl: detail?.thumbnailUrl ?? null,
          existingUrl: v.thumbnailUrl,
          prev: readThumbState(v.rawJson),
          isDiscovery: true,
          now: now2,
          // fbcdn IS server-fetchable via the proxy, so a recovered FB cover is
          // fully verifiable (unlike TikTok's datacenter-blocked CDN).
          verifiable: !isTikTokCdnHost(detail?.thumbnailUrl),
        });
        await store.updateVideo(v.id, {
          thumbnailUrl: ts.thumbnailUrl,
          rawJson: mergeThumbIntoRaw(v.rawJson, ts.thumb) as Video["rawJson"],
        });
        await store.addCollectionAttempt({
          refreshRunId,
          platform,
          provider: "socialcrawl",
          actorId: null,
          kind: "detail",
          inputDescription: `socialcrawl facebook thumb-repair · 1cr · ${detail?.thumbnailUrl ? "recovered" : "none"}`,
          success: Boolean(detail?.thumbnailUrl),
          runId: null,
          itemCount: detail?.thumbnailUrl ? 1 : 0,
          error: detail?.thumbnailUrl ? null : "no thumbnail in detail response",
          capturedAt: now2,
        });
        if (ts.thumbnailUrl && ts.thumb.status === "valid") repaired++;
      }
      if (needRepair.length > 0) {
        log.push(`facebook: thumbnail repair — recovered ${repaired}/${needRepair.length} via detail endpoint`);
      }
    }

    if (profile) {
      await store.updateProfile(profile.id, {
        lastDiscoveredAt: capturedAt,
        status: readiness.sourceStatus === "demo" ? "demo" : "live",
      });
    }
    // Record the success on the platform's ProviderConfig — creating it when
    // it doesn't exist yet (fresh database configured purely via env vars).
    await store.upsertProviderConfig({
      platform,
      providerType: provider.providerType,
      actorId: config?.actorId ?? (provider instanceof ApifyProvider ? provider.actorId() : null),
      status: "live",
      lastTestedAt: config?.lastTestedAt ?? null,
      lastTestResult: config?.lastTestResult ?? null,
      detectedFields: config?.detectedFields ?? [],
      supportsMetadata: config?.supportsMetadata ?? true,
      supportsMetrics: config?.supportsMetrics ?? true,
      supportsComments: config?.supportsComments ?? provider.supportsComments,
      supportsDiscovery: config?.supportsDiscovery ?? provider.supportsDiscovery,
      inputOverride: config?.inputOverride ?? null,
      lastSuccessfulRefreshAt: capturedAt,
    });

    // If the campaign start date is still unknown, learn it from seed videos.
    if (!campaign.startDate) {
      const all = await store.listVideos({ includeHidden: true });
      const seedDates = all
        .filter((v) => v.isSeed && v.publishedAt)
        .map((v) => v.publishedAt as string)
        .sort();
      if (seedDates.length > 0) {
        await store.updateCampaign(campaign.id, { startDate: seedDates[0] });
        campaign.startDate = seedDates[0];
      }
    }

    log.push(
      `${platform}: ${out.videosUpdated} video(s), ${out.commentsUpdated} new comment(s), ${out.newVideosDiscovered} discovered, ${fetched.attempts.length} actor run(s)`,
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    out.reason = reason;
    // Last-known-good protection. A single thrown cycle must not wipe healthy
    // data: videos that have refreshed successfully before keep their thumbnail,
    // metrics, and "live" status (the display layer flags them stale). Only
    // videos that have NEVER succeeded surface the failure to the user.
    const everGood = videos.filter((v) => v.lastRefreshedAt !== null);
    const neverGood = videos.filter((v) => v.lastRefreshedAt === null);
    out.status = everGood.length > 0 ? "partial" : "failed";
    log.push(
      `${platform}: ${out.status === "partial" ? "partial" : "FAILED"} — ${reason}` +
        (everGood.length > 0 ? ` (kept ${everGood.length} last-known-good video(s))` : ""),
    );
    for (const v of neverGood) {
      await store.updateVideo(v.id, {
        sourceStatus: "refresh_failed",
        errorMessage: reason.slice(0, 300),
      });
    }
    // Only flag the provider itself as failing when nothing could be salvaged;
    // otherwise keep its last-known-good status so public health stays honest.
    if (config && everGood.length === 0) {
      await store.upsertProviderConfig({ ...config, status: "actor_test_failed" });
    }
  }

  return out;
}

/**
 * Write one metrics snapshot for a video, applying monotonic-view protection (a
 * lower-than-last-confirmed reading is recorded as null so the display keeps the
 * last confirmed value). Shared by the profile-sweep loop and the per-post DUE
 * lane. The raw payload is already stored on the video, so snapshots carry none.
 */
async function writeMetricsSnapshot(
  store: Store,
  video: Video,
  n: NormalizedVideo,
  capturedAt: string,
  log: string[],
  platform: Platform,
): Promise<void> {
  const prev = (await store.listSnapshots(video.id))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
    .find((s) => s.views !== null);
  const { views, rejectedLower } = applyMonotonicViews(n.views, prev?.views ?? null);
  if (rejectedLower !== null) {
    log.push(
      `${platform}: rejected lower view count ${rejectedLower} < ${prev?.views} for ${
        video.externalVideoId ?? video.id
      } (source fluctuation — keeping last confirmed)`,
    );
  }
  await store.addSnapshot({
    videoId: video.id,
    capturedAt,
    views,
    likes: n.likes,
    comments: n.comments,
    shares: n.shares,
    saves: n.saves,
    bookmarks: n.bookmarks,
    engagementRate: engagementRate({ ...n, views }),
    rawJson: null,
  });
}

/**
 * Repair an existing tracked record that was wrongly EXCLUDED (corrupt/Jan-1970
 * publishedAt, admin-hidden, or a stale review flag) once the provider confirms a
 * valid eligible date. Fixes the date, un-hides it, clears the review flag, and
 * refreshes basic metadata — so a real campaign video that was "already tracked"
 * but invisible re-enters all totals. Never used for genuine pre-campaign content
 * (the caller gates on eligibility).
 */
async function healExistingVideo(store: Store, existing: Video, n: NormalizedVideo): Promise<Video> {
  const rawObj = n.rawJson && typeof n.rawJson === "object" ? { ...(n.rawJson as Record<string, unknown>) } : {};
  delete rawObj.discoveryReview;
  delete rawObj.discoveryReviewReason;
  return store.updateVideo(existing.id, {
    publishedAt: n.publishedAt ?? existing.publishedAt,
    hidden: false,
    status: "active",
    sourceStatus: "live",
    errorMessage: null,
    title: existing.title ?? n.title,
    caption: n.caption ?? existing.caption,
    thumbnailUrl: n.thumbnailUrl ?? existing.thumbnailUrl,
    rawJson: rawObj as Video["rawJson"],
  });
}

/**
 * Insert a newly DISCOVERED campaign video. review=true persists it hidden +
 * flagged (rawJson.discoveryReview) so it stays out of every public total until
 * an admin promotes it from the "Possible new content" queue; review=false adds
 * it as an active tracked video (counts immediately and gets a snapshot this run).
 */
async function insertDiscoveredVideo(
  store: Store,
  campaign: Campaign,
  platform: Platform,
  profileId: string | null,
  n: NormalizedVideo,
  review: boolean,
  reviewReason?: string,
): Promise<Video> {
  const now = new Date().toISOString();
  const rawObj = n.rawJson && typeof n.rawJson === "object" ? (n.rawJson as Record<string, unknown>) : {};
  // Seed the thumb state (valid / valid_unverified for TikTok) up front.
  const initThumb = initialThumbState({
    thumbnailUrl: n.thumbnailUrl,
    now,
    verifiable: !isTikTokCdnHost(n.thumbnailUrl),
  });
  const baseRaw = review
    ? { ...rawObj, discoveryReview: true, discoveryReviewReason: reviewReason ?? "review" }
    : (n.rawJson ?? null);
  return store.insertVideo({
    campaignId: campaign.id,
    platform,
    profileId,
    originalUrl: n.originalUrl ?? `unknown:${n.externalVideoId}`,
    externalVideoId: n.externalVideoId,
    title: n.title,
    caption: n.caption,
    thumbnailUrl: initThumb.thumbnailUrl,
    publishedAt: n.publishedAt,
    firstTrackedAt: now,
    lastRefreshedAt: review ? null : now,
    status: "active",
    episodeGroupId: review ? null : await inferEpisodeGroup(store, platform, n),
    sourceStatus: "live",
    errorMessage: null,
    hidden: review,
    isSeed: false,
    rawJson: mergeThumbIntoRaw(baseRaw, initThumb.thumb) as Video["rawJson"],
  });
}

async function upsertFetchedVideo(
  store: Store,
  campaign: Campaign,
  platform: Platform,
  profileId: string | null,
  n: NormalizedVideo,
  out: RefreshReport["platforms"][number],
  isDiscovery = false,
): Promise<Video | null> {
  if (!n.originalUrl && !n.externalVideoId) return null;
  const existing = await store.findVideoByUrlOrExternalId(
    platform,
    n.originalUrl,
    n.externalVideoId,
  );
  const now = new Date().toISOString();

  if (existing) {
    // Thumbnail retry: keep last-known-good / manual thumbnails, retry missing
    // ones on discovery pulls only, cap attempts so we never retry forever.
    const ts = nextThumbnailState({
      resolvedUrl: n.thumbnailUrl,
      existingUrl: existing.thumbnailUrl,
      prev: readThumbState(existing.rawJson),
      isDiscovery,
      now,
      // TikTok's CDN can't be server-verified (it blocks Vercel) → valid_unverified.
      verifiable: !isTikTokCdnHost(n.thumbnailUrl),
    });
    return store.updateVideo(existing.id, {
      // Never clobber admin overrides or known values with nulls.
      title: existing.title ?? n.title,
      caption: n.caption ?? existing.caption,
      thumbnailUrl: ts.thumbnailUrl,
      publishedAt: existing.publishedAt ?? n.publishedAt,
      externalVideoId: existing.externalVideoId ?? n.externalVideoId,
      lastRefreshedAt: now,
      status: "active",
      sourceStatus: "live",
      errorMessage: null,
      rawJson: mergeThumbIntoRaw(n.rawJson ?? existing.rawJson, ts.thumb) as Video["rawJson"],
    });
  }

  // Strict campaign-inclusion gate for any NEW record. Normal refresh is now
  // tracked-only and never reaches this branch; this is defense-in-depth for any
  // future discovery path (e.g. an admin "add from review queue" flow). Reject
  // anything that isn't eligible campaign content — invalid/epoch date, before
  // the campaign start, unsupported platform, or missing canonical URL.
  if (
    !isCampaignEligible(
      {
        platform,
        originalUrl: n.originalUrl,
        publishedAt: n.publishedAt,
        isSeed: false,
        episodeGroupId: null,
      },
      campaignStartMs(),
      null,
    )
  ) {
    return null;
  }

  // Only actual videos enter the tracker — profile feeds (Facebook) also
  // return photo/text posts, which must not compete in video metrics.
  if (
    n.rawJson &&
    typeof n.rawJson === "object" &&
    !isLikelyVideoItem(n.rawJson as Record<string, unknown>, platform)
  ) {
    return null;
  }

  // Seed the thumb state so a valid-looking cover (incl. TikTok HEIC) is stored
  // as valid / valid_unverified and not needlessly retried on the next pull.
  const initThumb = initialThumbState({
    thumbnailUrl: n.thumbnailUrl,
    now,
    verifiable: !isTikTokCdnHost(n.thumbnailUrl),
  });
  const created = await store.insertVideo({
    campaignId: campaign.id,
    platform,
    profileId,
    originalUrl: n.originalUrl ?? `unknown:${n.externalVideoId}`,
    externalVideoId: n.externalVideoId,
    title: n.title,
    caption: n.caption,
    thumbnailUrl: initThumb.thumbnailUrl,
    publishedAt: n.publishedAt,
    firstTrackedAt: now,
    lastRefreshedAt: now,
    status: "active",
    episodeGroupId: await inferEpisodeGroup(store, platform, n),
    sourceStatus: "live",
    errorMessage: null,
    hidden: false,
    isSeed: false,
    rawJson: mergeThumbIntoRaw(n.rawJson, initThumb.thumb) as Video["rawJson"],
  });
  out.newVideosDiscovered++;
  await emitNewVideoAlert(store, campaign, created);
  return created;
}

/** Normalized caption prefix used to match the same concept across platforms. */
function captionKey(text: string | null): string | null {
  if (!text) return null;
  const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40);
  return key.length >= 12 ? key : null;
}

/**
 * Auto-assign an episode when the same concept already exists on another
 * platform (creators cross-post the same caption): copy its episode label.
 */
async function inferEpisodeGroup(
  store: Store,
  platform: Platform,
  n: NormalizedVideo,
): Promise<string | null> {
  const key = captionKey(n.caption ?? n.title);
  if (!key) return null;
  const all = await store.listVideos({ includeHidden: true });
  for (const v of all) {
    if (v.platform === platform || !v.episodeGroupId) continue;
    if (captionKey(v.caption ?? v.title) === key) return v.episodeGroupId;
  }
  return null;
}
