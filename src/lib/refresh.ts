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
  Video,
} from "./types";
import { PLATFORMS } from "./types";
import type { Store } from "./store/types";
import { ensureSeedData, effectiveStartDate } from "./seed";
import { resolveProvider } from "./providers/registry";
import { ApifyProvider } from "./providers/apify-provider";
import { mergeNormalizedVideos, metricCompleteness } from "./apify/normalize";
import { engagementRate } from "./metrics";
import { tagComment } from "./intel/keywords";
import { classifyComment } from "./intel/sentiment";
import { emitNewVideoAlert, emitRefreshFailureAlert, generateAlerts } from "./alerts";

const globalForRefresh = globalThis as unknown as { __wachterRefreshing?: Promise<RefreshReport> };

/** Serializes refreshes — a second trigger while one is running awaits it. */
export function runRefresh(trigger: "manual" | "cron" | "script"): Promise<RefreshReport> {
  if (globalForRefresh.__wachterRefreshing) return globalForRefresh.__wachterRefreshing;
  const p = doRefresh(trigger).finally(() => {
    globalForRefresh.__wachterRefreshing = undefined;
  });
  globalForRefresh.__wachterRefreshing = p;
  return p;
}

async function doRefresh(trigger: "manual" | "cron" | "script"): Promise<RefreshReport> {
  const { getStore } = await import("./store");
  const store = getStore();
  const campaign = await ensureSeedData(store);
  const startedAt = new Date().toISOString();
  const log: string[] = [];

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

  const report: RefreshReport = {
    runId: run.id,
    startedAt,
    finishedAt: startedAt,
    status: "success",
    platforms: [],
    errors: [],
  };

  for (const platform of PLATFORMS) {
    const platformReport = await refreshPlatform(store, campaign, platform, log, run.id);
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
  report.status =
    attempted.length === 0
      ? "partial"
      : failed.length === 0
        ? "success"
        : failed.length === attempted.length
          ? "failed"
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

async function refreshPlatform(
  store: Store,
  campaign: Campaign,
  platform: Platform,
  log: string[],
  refreshRunId: string,
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

  try {
    let fetched: {
      videos: NormalizedVideo[];
      commentsByVideo: Record<string, NormalizedComment[]>;
      attempts: import("./providers/types").AttemptDraft[];
    };
    if (provider.fetchPlatform) {
      fetched = await provider.fetchPlatform(profile, videos, since);
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

    for (const { merged: n, commentKeys } of groups.values()) {
      const video = await upsertFetchedVideo(store, campaign, platform, profile?.id ?? null, n, out);
      if (!video) continue;

      await store.addSnapshot({
        videoId: video.id,
        capturedAt,
        views: n.views,
        likes: n.likes,
        comments: n.comments,
        shares: n.shares,
        saves: n.saves,
        bookmarks: n.bookmarks,
        engagementRate: engagementRate(n),
        rawJson: null, // raw payload already stored on the video
      });
      out.videosUpdated++;

      const comments = [...commentKeys].flatMap((k) => fetched.commentsByVideo[k] ?? []);
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
      `${platform}: ${out.videosUpdated} video(s), ${out.commentsUpdated} new comment(s), ${out.newVideosDiscovered} discovered`,
    );
  } catch (e) {
    out.status = "failed";
    out.reason = e instanceof Error ? e.message : String(e);
    log.push(`${platform}: FAILED — ${out.reason}`);
    for (const v of videos) {
      await store.updateVideo(v.id, {
        sourceStatus: "refresh_failed",
        errorMessage: out.reason.slice(0, 300),
      });
    }
    if (config) {
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
