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

/** One collection attempt (an actor run / API sweep) for the attempt log. */
export interface AttemptDraft {
  provider: ProviderType;
  actorId: string | null;
  /** discover | videos | backup */
  kind: string;
  inputDescription: string;
  success: boolean;
  runId: string | null;
  itemCount: number;
  error: string | null;
}

/** Batch result for one platform refresh (one actor run / API sweep). */
export interface PlatformFetchResult {
  videos: NormalizedVideo[];
  /** Keyed by externalVideoId (preferred) or originalUrl. */
  commentsByVideo: Record<string, NormalizedComment[]>;
  /** Every collection attempt made during this fetch, success or failure. */
  attempts: AttemptDraft[];
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
   *
   * `opts.wantComments` is the cost lever: on a metrics-only refresh it is
   * false, so providers must NOT request expensive comment add-ons (TikTok
   * commentsPerPost / side dataset, YouTube commentThreads). Comment COUNTS
   * still come back with the cheap metric item; only comment TEXT is gated.
   */
  fetchPlatform?(
    profile: PlatformProfile | null,
    videos: Video[],
    since: Date,
    opts?: PlatformFetchOptions,
  ): Promise<PlatformFetchResult>;
}

export interface PlatformFetchOptions {
  /** Pull full comment detail (text) this cycle. Default true for back-compat. */
  wantComments?: boolean;
  /** Max per-video comment fetches allowed this call (in-run credit budget so a
   *  single cycle cannot overshoot the SocialCrawl daily cap). Unset = unlimited. */
  commentBudget?: number;
}
