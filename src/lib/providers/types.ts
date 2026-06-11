// Provider abstraction: one adapter per data source. The refresh pipeline
// talks only to this interface.

import type {
  NormalizedComment,
  NormalizedVideo,
  Platform,
  PlatformProfile,
  ProviderStatusValue,
  ProviderType,
  SourceStatus,
  Video,
} from "../types";

export interface ProviderReadiness {
  ready: boolean;
  status: ProviderStatusValue;
  /** UI-facing source status (e.g. "actor_not_configured"). */
  sourceStatus: SourceStatus;
  detail: string | null;
}

/** Batch result for one platform refresh (one actor run / API sweep). */
export interface PlatformFetchResult {
  videos: NormalizedVideo[];
  /** Keyed by externalVideoId (preferred) or originalUrl. */
  commentsByVideo: Record<string, NormalizedComment[]>;
}

export interface SocialPlatformProvider {
  platform: Platform;
  providerType: ProviderType;
  supportsComments: boolean;
  supportsDiscovery: boolean;
  supportsSavesOrBookmarks: boolean;

  /** Cheap, synchronous config check — no network. */
  readiness(): ProviderReadiness;

  /** Discover videos published at/after `since` from a profile. */
  discoverNewVideos(profile: PlatformProfile, since: Date): Promise<NormalizedVideo[]>;

  /** Fetch metadata (+metrics when the source returns them) for one URL. */
  getVideoMetadata(url: string): Promise<NormalizedVideo | null>;

  /** Fetch current metrics for one tracked video. */
  getVideoMetrics(video: Video): Promise<NormalizedVideo | null>;

  /** Fetch comments for one tracked video ([] when unsupported). */
  getVideoComments(video: Video): Promise<NormalizedComment[]>;

  /**
   * Batch fast-path used by the refresh pipeline: one provider call covers
   * discovery + metrics + comments for the whole platform. Implementations
   * that can't batch can omit this; the pipeline falls back to per-video calls.
   */
  fetchPlatform?(
    profile: PlatformProfile | null,
    videos: Video[],
    since: Date,
  ): Promise<PlatformFetchResult>;
}
