// Official YouTube Data API v3 provider — preferred for YouTube when
// YOUTUBE_API_KEY is set. Quota-cheap: videos.list + playlistItems.list.

import { getYouTubeApiKey } from "../config";
import type {
  NormalizedComment,
  NormalizedVideo,
  PlatformProfile,
  Video,
} from "../types";
import { parseProfileUrl, parseVideoUrl } from "../url-parse";
import type {
  PlatformFetchOptions,
  PlatformFetchResult,
  ProviderReadiness,
  SocialPlatformProvider,
} from "./types";

const BASE = "https://www.googleapis.com/youtube/v3";

interface YtVideoItem {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelTitle?: string;
    thumbnails?: Record<string, { url?: string }>;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
}

export class YouTubeApiProvider implements SocialPlatformProvider {
  platform = "youtube" as const;
  providerType = "youtube_api" as const;
  supportsComments = true;
  supportsDiscovery = true;
  supportsSavesOrBookmarks = false;

  readiness(): ProviderReadiness {
    if (!getYouTubeApiKey()) {
      return {
        ready: false,
        status: "token_missing",
        sourceStatus: "needs_api_key",
        detail: "Set YOUTUBE_API_KEY (or configure an Apify YouTube actor)",
      };
    }
    return { ready: true, status: "live", sourceStatus: "live", detail: null };
  }

  private async yt(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const key = getYouTubeApiKey();
    if (!key) throw new Error("YOUTUBE_API_KEY not configured");
    const qs = new URLSearchParams({ ...params, key });
    const res = await fetch(`${BASE}/${path}?${qs}`, { cache: "no-store" });
    if (!res.ok) {
      const body = await res.text();
      // Never include the key in errors (it's only in the query string).
      throw new Error(`YouTube API ${path} failed (HTTP ${res.status}): ${body.slice(0, 200).replaceAll(key, "[REDACTED]")}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  private toNormalized(item: YtVideoItem): NormalizedVideo {
    const thumbs = item.snippet?.thumbnails ?? {};
    const thumb =
      thumbs.maxres?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null;
    const stats = item.statistics ?? {};
    return {
      platform: "youtube",
      originalUrl: `https://www.youtube.com/shorts/${item.id}`,
      externalVideoId: item.id,
      title: item.snippet?.title ?? null,
      caption: item.snippet?.description || null,
      thumbnailUrl: thumb,
      publishedAt: item.snippet?.publishedAt ?? null,
      authorName: item.snippet?.channelTitle ?? null,
      authorHandle: null,
      views: stats.viewCount !== undefined ? Number(stats.viewCount) : null,
      likes: stats.likeCount !== undefined ? Number(stats.likeCount) : null,
      comments: stats.commentCount !== undefined ? Number(stats.commentCount) : null,
      shares: null, // YouTube API does not expose share counts
      saves: null,
      bookmarks: null,
      rawJson: item,
    };
  }

  private async fetchVideosByIds(ids: string[]): Promise<NormalizedVideo[]> {
    if (ids.length === 0) return [];
    const data = await this.yt("videos", {
      part: "snippet,statistics",
      id: ids.slice(0, 50).join(","),
    });
    const items = (data.items ?? []) as YtVideoItem[];
    return items.map((it) => this.toNormalized(it));
  }

  private async resolveUploadsPlaylist(profile: PlatformProfile): Promise<string | null> {
    const parsed = parseProfileUrl(profile.profileUrl);
    const params: Record<string, string> = { part: "contentDetails" };
    if (profile.externalProfileId) params.id = profile.externalProfileId;
    else if (parsed?.handle) params.forHandle = parsed.handle;
    else return null;
    const data = await this.yt("channels", params);
    const items = (data.items ?? []) as Array<{
      contentDetails?: { relatedPlaylists?: { uploads?: string } };
    }>;
    return items[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
  }

  async discoverNewVideos(profile: PlatformProfile, since: Date): Promise<NormalizedVideo[]> {
    const uploads = await this.resolveUploadsPlaylist(profile);
    if (!uploads) return [];
    const data = await this.yt("playlistItems", {
      part: "contentDetails",
      playlistId: uploads,
      maxResults: "50",
    });
    const items = (data.items ?? []) as Array<{
      contentDetails?: { videoId?: string; videoPublishedAt?: string };
    }>;
    const ids = items
      .filter((it) => {
        const at = it.contentDetails?.videoPublishedAt;
        return at ? new Date(at) >= since : true;
      })
      .map((it) => it.contentDetails?.videoId)
      .filter((id): id is string => Boolean(id));
    return this.fetchVideosByIds(ids);
  }

  /**
   * Enumerate uploads published on/after `since`, paging the uploads playlist
   * (50/page, newest-first) up to `maxPages`, stopping once an older item is
   * reached. Free YouTube Data API quota (no SocialCrawl credits). Used by the
   * Bootcamp import dry run to auto-discover YouTube Shorts from the start date
   * forward — the one platform whose back-catalog IS enumerable.
   */
  async listRecentUploads(
    profile: PlatformProfile,
    since: Date,
    maxPages = 6,
  ): Promise<NormalizedVideo[]> {
    const uploads = await this.resolveUploadsPlaylist(profile);
    if (!uploads) return [];
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < Math.max(1, maxPages); page++) {
      const params: Record<string, string> = {
        part: "contentDetails",
        playlistId: uploads,
        maxResults: "50",
      };
      if (pageToken) params.pageToken = pageToken;
      const data = await this.yt("playlistItems", params);
      const items = (data.items ?? []) as Array<{
        contentDetails?: { videoId?: string; videoPublishedAt?: string };
      }>;
      let reachedOlder = false;
      for (const it of items) {
        const at = it.contentDetails?.videoPublishedAt;
        const vid = it.contentDetails?.videoId;
        if (!vid) continue;
        if (at && new Date(at) < since) {
          reachedOlder = true;
          continue;
        }
        ids.push(vid);
      }
      pageToken = (data.nextPageToken as string | undefined) ?? undefined;
      if (reachedOlder || !pageToken) break;
    }
    // Fetch full metadata in chunks of 50.
    const out: NormalizedVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      out.push(...(await this.fetchVideosByIds(ids.slice(i, i + 50))));
    }
    return out;
  }

  async getVideoMetadata(url: string): Promise<NormalizedVideo | null> {
    const id = parseVideoUrl(url)?.externalVideoId;
    if (!id) return null;
    const videos = await this.fetchVideosByIds([id]);
    return videos[0] ?? null;
  }

  async getVideoMetrics(video: Video): Promise<NormalizedVideo | null> {
    return this.getVideoMetadata(video.originalUrl);
  }

  async getVideoComments(video: Video): Promise<NormalizedComment[]> {
    const id = video.externalVideoId ?? parseVideoUrl(video.originalUrl)?.externalVideoId;
    if (!id) return [];
    try {
      const data = await this.yt("commentThreads", {
        part: "snippet",
        videoId: id,
        maxResults: "50",
        order: "time",
        textFormat: "plainText",
      });
      const items = (data.items ?? []) as Array<{
        id: string;
        snippet?: {
          totalReplyCount?: number;
          topLevelComment?: {
            snippet?: {
              authorDisplayName?: string;
              textDisplay?: string;
              likeCount?: number;
              publishedAt?: string;
            };
          };
        };
      }>;
      return items
        .map((it): NormalizedComment | null => {
          const s = it.snippet?.topLevelComment?.snippet;
          if (!s?.textDisplay) return null;
          return {
            externalCommentId: it.id,
            authorName: s.authorDisplayName ?? null,
            text: s.textDisplay,
            postedAt: s.publishedAt ?? null,
            likes: s.likeCount ?? null,
            replyCount: it.snippet?.totalReplyCount ?? null,
            permalink: `https://www.youtube.com/watch?v=${id}&lc=${it.id}`,
            rawJson: it,
          };
        })
        .filter((c): c is NormalizedComment => c !== null);
    } catch {
      // Comments can be disabled per-video; treat as no comments, not failure.
      return [];
    }
  }

  async fetchPlatform(
    profile: PlatformProfile | null,
    videos: Video[],
    since: Date,
    opts: PlatformFetchOptions = {},
  ): Promise<PlatformFetchResult> {
    const wantComments = opts.wantComments ?? true;
    const result: PlatformFetchResult = { videos: [], commentsByVideo: {}, attempts: [] };
    const ids = new Set<string>();
    for (const v of videos) {
      const id = v.externalVideoId ?? parseVideoUrl(v.originalUrl)?.externalVideoId;
      if (id) ids.add(id);
    }
    if (profile) {
      // Discovery failure must not block metrics for known videos — but it MUST be
      // logged: a silent failure here once left YouTube Shorts discovery dead for
      // weeks with zero admin visibility (no attempt row, no error anywhere).
      try {
        const discovered = await this.discoverNewVideos(profile, since);
        for (const d of discovered) if (d.externalVideoId) ids.add(d.externalVideoId);
        result.attempts.push({
          provider: "youtube_api",
          actorId: null,
          kind: "discovery",
          inputDescription: "playlistItems uploads sweep",
          success: true,
          runId: null,
          itemCount: discovered.length,
          error: null,
        });
      } catch (e) {
        result.attempts.push({
          provider: "youtube_api",
          actorId: null,
          kind: "discovery",
          inputDescription: "playlistItems uploads sweep",
          success: false,
          runId: null,
          itemCount: 0,
          error: e instanceof Error ? e.message.slice(0, 300) : String(e),
        });
      }
    }
    try {
      result.videos = await this.fetchVideosByIds([...ids]);
      result.attempts.push({
        provider: "youtube_api",
        actorId: null,
        kind: "videos",
        inputDescription: `videos.list id=[${ids.size} id(s)]`,
        success: result.videos.length > 0,
        runId: null,
        itemCount: result.videos.length,
        error: null,
      });
    } catch (e) {
      result.attempts.push({
        provider: "youtube_api",
        actorId: null,
        kind: "videos",
        inputDescription: `videos.list id=[${ids.size} id(s)]`,
        success: false,
        runId: null,
        itemCount: 0,
        error: e instanceof Error ? e.message.slice(0, 300) : String(e),
      });
      throw e;
    }
    // Comment detail (commentThreads, 1 quota unit/video) only on a
    // comment-detail cycle — metrics-only refreshes skip it. Comment COUNTS
    // already arrive cheaply on each video via statistics.commentCount.
    if (wantComments) {
      for (const v of result.videos) {
        if (!v.externalVideoId) continue;
        const tracked = videos.find((t) => t.externalVideoId === v.externalVideoId);
        const fake: Video = tracked ?? {
          id: "",
          campaignId: "",
          platform: "youtube",
          profileId: null,
          originalUrl: v.originalUrl ?? "",
          externalVideoId: v.externalVideoId,
          title: null, caption: null, thumbnailUrl: null, publishedAt: null,
          firstTrackedAt: "", lastRefreshedAt: null, status: "active",
          episodeGroupId: null, sourceStatus: "live", errorMessage: null,
          hidden: false, isSeed: false, rawJson: null,
        };
        const comments = await this.getVideoComments(fake);
        if (comments.length > 0) result.commentsByVideo[v.externalVideoId] = comments;
      }
    }
    return result;
  }
}
