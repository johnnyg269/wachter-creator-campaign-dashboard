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
import { applyMonotonicViews, engagementRate } from "./metrics";
import { tagComment } from "./intel/keywords";
import { classifyComment } from "./intel/sentiment";
import { emitNewVideoAlert, emitRefreshFailureAlert, generateAlerts } from "./alerts";
import {
  decideScheduledRefresh,
  encodeRunMode,
  getRefreshPolicyConfig,
  localDateKey,
  type RunMode,
} from "./refresh-policy";

const globalForRefresh = globalThis as unknown as { __wachterRefreshing?: Promise<RefreshReport> };

/** A crashed refresh's lock expires after this — nothing blocks forever. */
export const REFRESH_LOCK_TTL_MS = 10 * 60 * 1000;
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
export function runRefresh(
  trigger: RefreshTrigger,
  opts: { force?: boolean } = {},
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
  const p = doRefresh(effective).finally(() => {
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

async function doRefresh(trigger: RefreshTrigger): Promise<RefreshReport> {
  const { getStore } = await import("./store");
  const store = getStore();
  const campaign = await ensureSeedData(store);
  const startedAt = new Date().toISOString();
  const log: string[] = [];

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
  if (trigger === "cron") {
    const cfg = getRefreshPolicyConfig();
    const attempts = await store.listCollectionAttempts(500);
    const todayKey = localDateKey(new Date(), cfg.quietTimezone);
    const todaysActorRuns = attempts.filter(
      (a) => localDateKey(new Date(a.capturedAt), cfg.quietTimezone) === todayKey,
    ).length;
    const policy = decideScheduledRefresh({
      recentRuns: await store.listRefreshRuns(60),
      todaysActorRuns,
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

  for (const platform of PLATFORMS) {
    const platformReport = await refreshPlatform(store, campaign, platform, log, run.id, mode);
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

  const { provider, readiness, config } = await resolveProvider(platform, store);
  out.providerType = provider.providerType;

  const profiles = (await store.listProfiles()).filter((p) => p.platform === platform);
  const profile = profiles[0] ?? null;
  const videos = (await store.listVideos({ platform, includeHidden: true })).filter(
    (v) => !v.hidden,
  );

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
  } else if (!mode.discovery && platform !== "youtube" && platform !== "facebook") {
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
      fetched = await provider.fetchPlatform(targetProfile, targetVideos, since, {
        wantComments: mode.comments,
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

    // Group fetched records by the tracked video they resolve to and merge —
    // one snapshot per video per refresh, never a views-less duplicate
    // clobbering a surface that did expose views.
    const groups = new Map<string, { merged: NormalizedVideo; commentKeys: Set<string> }>();
    for (const n of fetched.videos) {
      const existing = await store.findVideoByUrlOrExternalId(
        platform,
        n.originalUrl,
        n.externalVideoId,
      );
      const gkey = existing ? `v:${existing.id}` : `n:${n.externalVideoId ?? n.originalUrl}`;
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

    for (const { merged: n, commentKeys } of groups.values()) {
      const video = await upsertFetchedVideo(store, campaign, platform, profile?.id ?? null, n, out);
      if (!video) continue;

      // Public view counts are monotonic — a LOWER reading than the last
      // confirmed value is a stale/cached source response, not real decline.
      // Record it as not-reported (null) so the display layer keeps the last
      // confirmed value, and log the rejected reading for the audit trail.
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
        rawJson: null, // raw payload already stored on the video
      });
      out.videosUpdated++;

      const comments = mode.comments
        ? [...commentKeys].flatMap((k) => fetched.commentsByVideo[k] ?? [])
        : [];
      for (const c of comments) {
        const tags = tagComment(c.text);
        const cls = classifyComment(c.text, tags);
        const { created } = await store.upsertComment({
          videoId: video.id,
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

async function upsertFetchedVideo(
  store: Store,
  campaign: Campaign,
  platform: Platform,
  profileId: string | null,
  n: NormalizedVideo,
  out: RefreshReport["platforms"][number],
): Promise<Video | null> {
  if (!n.originalUrl && !n.externalVideoId) return null;
  const existing = await store.findVideoByUrlOrExternalId(
    platform,
    n.originalUrl,
    n.externalVideoId,
  );
  const now = new Date().toISOString();

  if (existing) {
    return store.updateVideo(existing.id, {
      // Never clobber admin overrides or known values with nulls.
      title: existing.title ?? n.title,
      caption: n.caption ?? existing.caption,
      thumbnailUrl: n.thumbnailUrl ?? existing.thumbnailUrl,
      publishedAt: existing.publishedAt ?? n.publishedAt,
      externalVideoId: existing.externalVideoId ?? n.externalVideoId,
      lastRefreshedAt: now,
      status: "active",
      sourceStatus: "live",
      errorMessage: null,
      rawJson: n.rawJson ?? existing.rawJson,
    });
  }

  // Campaign rule: only track NEW videos published at/after the start point.
  // (Seeds are matched above by URL/ID regardless of date; discovery sweeps
  // intentionally over-fetch a few days back to catch them.)
  if (n.publishedAt && campaign.startDate && n.publishedAt < campaign.startDate) {
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

  const created = await store.insertVideo({
    campaignId: campaign.id,
    platform,
    profileId,
    originalUrl: n.originalUrl ?? `unknown:${n.externalVideoId}`,
    externalVideoId: n.externalVideoId,
    title: n.title,
    caption: n.caption,
    thumbnailUrl: n.thumbnailUrl,
    publishedAt: n.publishedAt,
    firstTrackedAt: now,
    lastRefreshedAt: now,
    status: "active",
    episodeGroupId: await inferEpisodeGroup(store, platform, n),
    sourceStatus: "live",
    errorMessage: null,
    hidden: false,
    isSeed: false,
    rawJson: n.rawJson,
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
