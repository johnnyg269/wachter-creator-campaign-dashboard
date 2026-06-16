// Fallback composite: a PRIMARY provider (SocialCrawl) with an optional
// FALLBACK (Apify). The refresh pipeline talks to this as one provider.
//
// Rules (Part 3):
//  - SocialCrawl success → NO Apify call for that platform.
//  - SocialCrawl failure (throw or 0 usable items) → try Apify, but only when
//    Apify is configured (cost policy gate). Fallback data does NOT overwrite
//    better SocialCrawl data — the pipeline's monotonic-view + last-known-good
//    protections keep a higher confirmed value safe.
//  - Total failure → return the primary's empty result so the pipeline's
//    empty-cycle guard preserves last-known-good (never wipes to zero).

import type { NormalizedComment, NormalizedVideo, Platform, PlatformProfile, Video } from "../types";
import type {
  PlatformFetchOptions,
  PlatformFetchResult,
  ProviderReadiness,
  SocialPlatformProvider,
} from "./types";

export class FallbackProvider implements SocialPlatformProvider {
  platform: Platform;
  providerType;
  supportsComments: boolean;
  supportsDiscovery: boolean;
  supportsSavesOrBookmarks: boolean;

  constructor(
    private primary: SocialPlatformProvider,
    private fallback: SocialPlatformProvider | null,
    private canFallback: boolean,
  ) {
    this.platform = primary.platform;
    this.providerType = primary.providerType; // active provider per call is logged on each attempt
    this.supportsComments = primary.supportsComments || Boolean(fallback?.supportsComments);
    this.supportsDiscovery = primary.supportsDiscovery || Boolean(fallback?.supportsDiscovery);
    this.supportsSavesOrBookmarks = primary.supportsSavesOrBookmarks;
  }

  readiness(): ProviderReadiness {
    const r = this.primary.readiness();
    if (r.ready) return r;
    // Primary not ready — defer to the fallback's readiness if we may use it.
    if (this.canFallback && this.fallback) return this.fallback.readiness();
    return r;
  }

  discoverNewVideos(profile: PlatformProfile, since: Date): Promise<NormalizedVideo[]> {
    return this.primary.discoverNewVideos(profile, since);
  }
  getVideoMetadata(url: string): Promise<NormalizedVideo | null> {
    return this.primary.getVideoMetadata(url);
  }
  getVideoMetrics(video: Video): Promise<NormalizedVideo | null> {
    return this.primary.getVideoMetrics(video);
  }
  getVideoComments(video: Video): Promise<NormalizedComment[]> {
    return this.primary.getVideoComments(video);
  }

  async fetchPlatform(
    profile: PlatformProfile | null,
    videos: Video[],
    since: Date,
    opts?: PlatformFetchOptions,
  ): Promise<PlatformFetchResult> {
    if (!this.primary.fetchPlatform) {
      throw new Error("primary provider has no fetchPlatform");
    }
    let primaryAttempts: PlatformFetchResult["attempts"] = [];
    try {
      const res = await this.primary.fetchPlatform(profile, videos, since, opts);
      if (res.videos.length > 0) return res; // success → no Apify
      primaryAttempts = res.attempts; // empty → consider fallback
    } catch (e) {
      primaryAttempts = [
        {
          provider: this.primary.providerType,
          actorId: null,
          kind: "metrics",
          inputDescription: `${this.platform} primary failed`,
          success: false,
          runId: null,
          itemCount: 0,
          error: e instanceof Error ? e.message.slice(0, 200) : String(e),
        },
      ];
    }

    // Primary failed/empty → Apify fallback only when configured (cost gate).
    if (this.canFallback && this.fallback?.fetchPlatform) {
      try {
        const fb = await this.fallback.fetchPlatform(profile, videos, since, opts);
        return { ...fb, attempts: [...primaryAttempts, ...fb.attempts] };
      } catch (e) {
        primaryAttempts.push({
          provider: this.fallback.providerType,
          actorId: null,
          kind: "fallback",
          inputDescription: `${this.platform} apify fallback failed`,
          success: false,
          runId: null,
          itemCount: 0,
          error: e instanceof Error ? e.message.slice(0, 200) : String(e),
        });
      }
    }
    // No usable data anywhere → empty result; pipeline keeps last-known-good.
    return { videos: [], commentsByVideo: {}, attempts: primaryAttempts };
  }
}
