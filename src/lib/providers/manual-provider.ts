// Manual provider — never fetches anything. Used when no live source is
// configured for a platform: videos are added by URL in /admin and metric
// snapshots can be entered manually for corrections.

import type { NormalizedComment, NormalizedVideo, Platform, PlatformProfile, Video } from "../types";
import { parseVideoUrl, tiktokPublishedAtFromId } from "../url-parse";
import type { ProviderReadiness, SocialPlatformProvider } from "./types";

export class ManualProvider implements SocialPlatformProvider {
  platform: Platform;
  providerType = "manual" as const;
  supportsComments = false;
  supportsDiscovery = false;
  supportsSavesOrBookmarks = false;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  readiness(): ProviderReadiness {
    return {
      ready: false,
      status: "untested",
      sourceStatus: "manual_required",
      detail: "No live source configured — add videos and snapshots in /admin",
    };
  }

  async discoverNewVideos(_profile: PlatformProfile, _since: Date): Promise<NormalizedVideo[]> {
    return [];
  }

  /** Builds a metadata-only record from what the URL itself encodes. */
  async getVideoMetadata(url: string): Promise<NormalizedVideo | null> {
    const parsed = parseVideoUrl(url);
    if (!parsed) return null;
    return {
      platform: parsed.platform,
      originalUrl: parsed.canonicalUrl,
      externalVideoId: parsed.externalVideoId,
      title: null,
      caption: null,
      thumbnailUrl: null,
      publishedAt:
        parsed.platform === "tiktok" && parsed.externalVideoId
          ? tiktokPublishedAtFromId(parsed.externalVideoId)
          : null,
      authorName: null,
      authorHandle: parsed.handle,
      views: null,
      likes: null,
      comments: null,
      shares: null,
      saves: null,
      bookmarks: null,
      rawJson: null,
    };
  }

  async getVideoMetrics(_video: Video): Promise<NormalizedVideo | null> {
    return null;
  }

  async getVideoComments(_video: Video): Promise<NormalizedComment[]> {
    return [];
  }
}
