// YouTube Shorts discovery health + catch-up. YouTube uses the FREE Data API
// (zero SocialCrawl credits, never Apify), so discovery can always run — this lib
// (a) reports discovery health (last run/insert, staleness, errors) and (b) scans
// the channel's uploads for a window (default 30 days) and inserts any missing
// Shorts through the normal safe path: dedup by URL/external id, never re-adds
// excluded/removed videos, explicit MTL tag (the current-campaign default, kept
// safe across refreshes by carryOverAdminTags), REAL initial metrics from the
// API (never fake), plus an optional initial comment pull. Read-only unless
// `insert` is requested.

import { isAdminExcluded } from "./campaigns";
import { tagComment } from "./intel/keywords";
import { classifyComment } from "./intel/sentiment";
import { engagementRate } from "./metrics";
import { YouTubeApiProvider } from "./providers/youtube-api-provider";
import { ensureSeedData } from "./seed";
import { getStore } from "./store";
import type { Store } from "./store/types";
import type { NormalizedVideo, PlatformProfile, Video } from "./types";

const STALE_WARNING_H = 24;
const STALE_CRITICAL_H = 72;

export interface YoutubeDiscoveryHealth {
  generatedAt: string;
  apiKeyConfigured: boolean;
  profileFound: boolean;
  uploadsPlaylistResolved: boolean | null;
  /** Newest youtube_api discovery attempt (from the collection-attempt log). */
  lastDiscoveryAttemptAt: string | null;
  lastDiscoveryAttemptOk: boolean | null;
  lastDiscoveryError: string | null;
  /** Newest tracked YouTube video by firstTrackedAt (when discovery last inserted). */
  lastYoutubeInsertAt: string | null;
  youtubeTracked: number;
  trackedLast7d: number;
  trackedLast21d: number;
  staleness: { hoursSinceLastInsert: number | null; level: "ok" | "warning" | "critical" };
}

export interface YoutubeCatchupResult {
  scannedSinceIso: string;
  apiFound: number;
  alreadyTracked: number;
  excludedSkipped: number;
  inserted: Array<{ id: string; url: string; publishedAt: string | null; views: number | null }>;
  commentsAdded: number;
  errors: string[];
  /** Whether the requested URL (if any) is now present / was already present. */
  urlCheck: { url: string; existed: boolean; insertedNow: boolean; excluded: boolean } | null;
}

async function youtubeProfile(store: Store): Promise<PlatformProfile | null> {
  const profiles = await store.listProfiles();
  return profiles.find((p) => p.platform === "youtube") ?? null;
}

export async function youtubeDiscoveryHealth(store: Store = getStore(), now: Date = new Date()): Promise<YoutubeDiscoveryHealth> {
  const provider = new YouTubeApiProvider();
  const apiKeyConfigured = provider.readiness().ready;
  const profile = await youtubeProfile(store);

  let uploadsPlaylistResolved: boolean | null = null;
  if (apiKeyConfigured && profile) {
    try {
      // Probe via a 1-item discovery call (free quota) — proves channel + uploads
      // lookup end-to-end without writing anything.
      await provider.discoverNewVideos(profile, new Date(now.getTime() - 24 * 3_600_000));
      uploadsPlaylistResolved = true;
    } catch {
      uploadsPlaylistResolved = false;
    }
  }

  const attempts = await store.listCollectionAttempts(2000);
  const disc = attempts
    .filter((a) => a.provider === "youtube_api" && a.kind === "discovery")
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];

  const yt = (await store.listVideos({ includeHidden: true })).filter((v) => v.platform === "youtube");
  let lastInsert: string | null = null;
  let last7 = 0, last21 = 0;
  for (const v of yt) {
    if (lastInsert === null || v.firstTrackedAt > lastInsert) lastInsert = v.firstTrackedAt;
    const age = now.getTime() - new Date(v.firstTrackedAt).getTime();
    if (age <= 7 * 86_400_000) last7++;
    if (age <= 21 * 86_400_000) last21++;
  }
  const hoursSinceLastInsert = lastInsert ? (now.getTime() - new Date(lastInsert).getTime()) / 3_600_000 : null;
  // Staleness keys off the last INSERT rather than the last attempt — an
  // "attempting but never inserting" pipeline is exactly the failure to surface.
  const level: YoutubeDiscoveryHealth["staleness"]["level"] =
    hoursSinceLastInsert === null || hoursSinceLastInsert > STALE_CRITICAL_H
      ? "critical"
      : hoursSinceLastInsert > STALE_WARNING_H
        ? "warning"
        : "ok";

  return {
    generatedAt: now.toISOString(),
    apiKeyConfigured,
    profileFound: profile !== null,
    uploadsPlaylistResolved,
    lastDiscoveryAttemptAt: disc?.capturedAt ?? null,
    lastDiscoveryAttemptOk: disc ? disc.success : null,
    lastDiscoveryError: disc && !disc.success ? (disc.error?.slice(0, 200) ?? null) : null,
    lastYoutubeInsertAt: lastInsert,
    youtubeTracked: yt.length,
    trackedLast7d: last7,
    trackedLast21d: last21,
    staleness: { hoursSinceLastInsert, level },
  };
}

/**
 * Scan the channel's uploads since `sinceDays` ago and (optionally) insert any
 * missing Shorts. Free Data API quota; no SocialCrawl, no Apify. `checkUrl` is
 * verified against both the API scan and the store (e.g. the reported-missing
 * short). Dedup + excluded-skip mirror the refresh upsert semantics.
 */
export async function youtubeShortsCatchup(
  store: Store,
  opts: {
    sinceDays?: number;
    insert?: boolean;
    checkUrl?: string;
    withComments?: boolean;
    now?: Date;
    /** Test seam: overrides the real Data API provider (uploads + comments). */
    providerOverride?: Pick<YouTubeApiProvider, "readiness" | "listRecentUploads" | "getVideoComments">;
  } = {},
): Promise<YoutubeCatchupResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const sinceDays = opts.sinceDays && opts.sinceDays > 0 ? Math.min(opts.sinceDays, 60) : 30;
  const since = new Date(now.getTime() - sinceDays * 86_400_000);
  const provider = opts.providerOverride ?? new YouTubeApiProvider();
  const res: YoutubeCatchupResult = {
    scannedSinceIso: since.toISOString(),
    apiFound: 0, alreadyTracked: 0, excludedSkipped: 0, inserted: [], commentsAdded: 0, errors: [],
    urlCheck: null,
  };

  const profile = await youtubeProfile(store);
  if (!provider.readiness().ready) { res.errors.push("YouTube API key not configured"); return res; }
  if (!profile) { res.errors.push("No YouTube profile is configured for the campaign"); return res; }

  let uploads: NormalizedVideo[] = [];
  try {
    uploads = await provider.listRecentUploads(profile, since);
  } catch (e) {
    res.errors.push(`uploads scan failed: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
    return res;
  }
  res.apiFound = uploads.length;
  await store.addCollectionAttempt({
    refreshRunId: null, platform: "youtube", provider: "youtube_api", actorId: null, kind: "discovery",
    inputDescription: `uploads catch-up scan (${sinceDays}d)`, success: true, runId: null,
    itemCount: uploads.length, error: null, capturedAt: nowIso,
  });

  const campaign = await ensureSeedData(store);
  for (const n of uploads) {
    if (!n.originalUrl && !n.externalVideoId) continue;
    const existing = await store.findVideoByUrlOrExternalId("youtube", n.originalUrl, n.externalVideoId);
    if (existing) {
      if (isAdminExcluded(existing)) res.excludedSkipped++; // removed stays removed
      else res.alreadyTracked++;
      continue;
    }
    if (opts.insert !== true) continue; // dry-run: report only
    try {
      const created = await store.insertVideo({
        campaignId: campaign.id,
        platform: "youtube",
        profileId: profile.id,
        originalUrl: n.originalUrl ?? `https://www.youtube.com/shorts/${n.externalVideoId}`,
        externalVideoId: n.externalVideoId,
        title: n.title,
        caption: n.caption,
        thumbnailUrl: n.thumbnailUrl,
        publishedAt: n.publishedAt,
        firstTrackedAt: nowIso,
        lastRefreshedAt: nowIso,
        status: "active",
        episodeGroupId: null,
        sourceStatus: "live",
        errorMessage: null,
        hidden: false,
        isSeed: false,
        // Explicit MTL tag (the current-campaign default) — protected across
        // refreshes by carryOverAdminTags; admin can reassign any time.
        rawJson: { campaign: "mtl" } as Video["rawJson"],
      });
      // REAL initial metrics from the API item (never fake, never null-clobber).
      await store.addSnapshot({
        videoId: created.id,
        capturedAt: nowIso,
        views: n.views, likes: n.likes, comments: n.comments, shares: n.shares,
        saves: n.saves, bookmarks: n.bookmarks,
        engagementRate: engagementRate(n),
        rawJson: null,
      });
      res.inserted.push({ id: created.id, url: created.originalUrl, publishedAt: created.publishedAt, views: n.views });
      if (opts.withComments !== false) {
        try {
          const comments = await provider.getVideoComments(created);
          for (const c of comments) {
            const tags = tagComment(c.text);
            const cls = classifyComment(c.text, tags);
            const { created: isNew } = await store.upsertComment({
              videoId: created.id, platform: "youtube", externalCommentId: c.externalCommentId,
              authorName: c.authorName, text: c.text, postedAt: c.postedAt, likes: c.likes,
              replyCount: c.replyCount, sentiment: cls.sentiment, needsResponse: cls.needsResponse,
              tags, permalink: c.permalink, capturedAt: nowIso, rawJson: null,
            });
            if (isNew) res.commentsAdded++;
          }
        } catch {
          // comments optional — never fail the insert
        }
      }
    } catch (e) {
      res.errors.push(`insert failed for ${n.originalUrl}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    }
  }

  if (opts.checkUrl) {
    const inScan = uploads.some((u) => u.originalUrl === opts.checkUrl);
    const existing = await store.findVideoByUrlOrExternalId("youtube", opts.checkUrl, null);
    res.urlCheck = {
      url: opts.checkUrl,
      existed: Boolean(existing) && !res.inserted.some((i) => i.url === opts.checkUrl),
      insertedNow: res.inserted.some((i) => i.url === opts.checkUrl),
      excluded: Boolean(existing && isAdminExcluded(existing)),
    };
    if (!existing && !inScan) res.errors.push(`checkUrl not in the ${sinceDays}d uploads scan — older than the window or not on this channel`);
  }
  return res;
}
