// Domain model shared across the store, providers, refresh pipeline, and UI.
// All timestamps are ISO-8601 strings so entities serialize cleanly across
// the JSON store, Postgres, and React Server Component boundaries.

export type Platform = "tiktok" | "youtube" | "instagram" | "facebook";

export const PLATFORMS: Platform[] = ["tiktok", "youtube", "instagram", "facebook"];

export const PLATFORM_LABELS: Record<Platform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
  instagram: "Instagram Reels",
  facebook: "Facebook Reels",
};

/** Per-video fetch state. */
export type VideoStatus = "active" | "unavailable" | "failed_fetch" | "needs_auth";

/**
 * Where a metric/video's data is coming from right now. Surfaced on every
 * card so live vs. not-connected is always obvious.
 */
export type SourceStatus =
  | "live"
  | "needs_api_key"
  | "token_connected"
  | "actor_not_configured"
  | "needs_apify_token"
  | "needs_auth"
  | "manual_required"
  | "refresh_failed"
  | "demo"
  | "waiting";

export const SOURCE_STATUS_LABELS: Record<SourceStatus, string> = {
  live: "Live",
  needs_api_key: "Needs API key",
  token_connected: "Apify token connected",
  actor_not_configured: "Actor not configured",
  needs_apify_token: "Needs Apify token",
  needs_auth: "Needs auth",
  manual_required: "Manual add required",
  refresh_failed: "Last refresh failed",
  demo: "Demo data",
  waiting: "Waiting for first refresh",
};

/** Provider-level status persisted on ProviderConfig. */
export type ProviderStatusValue =
  | "live"
  | "working"
  | "token_missing"
  | "actor_missing"
  | "actor_test_failed"
  | "output_unmapped"
  | "comments_unavailable"
  | "discovery_unavailable"
  | "untested";

export type ProviderType = "apify" | "youtube_api" | "manual" | "mock";

export type AlertSeverity = "info" | "opportunity" | "warning" | "critical";

export type AlertType =
  | "video_spike"
  | "comment_spike"
  | "high_engagement"
  | "negative_comment_spike"
  | "question_needs_response"
  | "refresh_failed"
  | "new_video"
  | "no_new_posts"
  | "manual_review"
  | "missing_thumbnail"
  | "missing_metrics";

export type AlertStatus = "open" | "reviewed";

export type Sentiment = "positive" | "neutral" | "negative" | "question";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface Campaign {
  id: string;
  name: string;
  creatorName: string;
  company: string;
  /** Campaign start point — videos published at/after this are tracked. */
  startDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformProfile {
  id: string;
  campaignId: string;
  platform: Platform;
  profileUrl: string;
  handle: string | null;
  externalProfileId: string | null;
  lastDiscoveredAt: string | null;
  status: SourceStatus;
}

export interface Video {
  id: string;
  campaignId: string;
  platform: Platform;
  profileId: string | null;
  originalUrl: string;
  externalVideoId: string | null;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  firstTrackedAt: string;
  lastRefreshedAt: string | null;
  status: VideoStatus;
  episodeGroupId: string | null;
  sourceStatus: SourceStatus;
  errorMessage: string | null;
  hidden: boolean;
  /** True for the original campaign seed URLs. */
  isSeed: boolean;
  rawJson: unknown | null;
}

/**
 * Point-in-time metrics. `null` means the platform did not expose the metric
 * — never coerce null to 0.
 */
export interface MetricSnapshot {
  id: string;
  videoId: string;
  capturedAt: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  bookmarks: number | null;
  /** engagements / views at capture time; null when not computable. */
  engagementRate: number | null;
  rawJson: unknown | null;
}

export interface Comment {
  id: string;
  videoId: string;
  platform: Platform;
  externalCommentId: string | null;
  authorName: string | null;
  text: string;
  postedAt: string | null;
  likes: number | null;
  replyCount: number | null;
  sentiment: Sentiment | null;
  /** True when the comment likely deserves a human response. */
  needsResponse: boolean;
  tags: string[];
  permalink: string | null;
  capturedAt: string;
  rawJson: unknown | null;
}

export interface RefreshRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "success" | "partial" | "failed";
  trigger: "manual" | "cron" | "script";
  platformsAttempted: Platform[];
  videosUpdated: number;
  commentsUpdated: number;
  newVideosDiscovered: number;
  errors: string[];
  rawLog: string[] | null;
}

export interface EpisodeGroup {
  id: string;
  campaignId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Alert {
  id: string;
  campaignId: string;
  videoId: string | null;
  platform: Platform | null;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  suggestedAction: string | null;
  createdAt: string;
  reviewedAt: string | null;
  status: AlertStatus;
  /** Stable key used to avoid duplicate open alerts for the same condition. */
  dedupeKey: string | null;
}

export interface ManualOverride {
  id: string;
  entityType: "video" | "campaign" | "snapshot" | "episode";
  entityId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  createdAt: string;
}

export interface ActorTestResult {
  ok: boolean;
  testedAt: string;
  inputUsed: unknown;
  inputDescription: string;
  itemCount: number;
  detectedFields: string[];
  normalizedPreview: NormalizedVideo | null;
  error: string | null;
  durationMs: number | null;
}

/**
 * One data-collection attempt (an actor run / API sweep), logged so admin can
 * see exactly which sources were tried and why a metric might be missing.
 */
export interface CollectionAttempt {
  id: string;
  refreshRunId: string | null;
  platform: Platform;
  provider: ProviderType;
  actorId: string | null;
  /** discover | videos | backup | comments */
  kind: string;
  inputDescription: string;
  success: boolean;
  /** Apify run ID when applicable. */
  runId: string | null;
  itemCount: number;
  error: string | null;
  capturedAt: string;
}

export interface ProviderConfig {
  id: string;
  platform: Platform;
  providerType: ProviderType;
  actorId: string | null;
  /** Optional backup actor, run only when the primary leaves gaps. */
  backupActorId?: string | null;
  status: ProviderStatusValue;
  lastTestedAt: string | null;
  lastTestResult: ActorTestResult | null;
  detectedFields: string[];
  supportsMetadata: boolean;
  supportsMetrics: boolean;
  supportsComments: boolean;
  supportsDiscovery: boolean;
  /** Optional admin-provided JSON template overriding the built input. */
  inputOverride: unknown | null;
  lastSuccessfulRefreshAt: string | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Normalized provider output (pre-persistence)
// ---------------------------------------------------------------------------

export interface NormalizedVideo {
  platform: Platform;
  originalUrl: string | null;
  externalVideoId: string | null;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  authorName: string | null;
  authorHandle: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  bookmarks: number | null;
  rawJson: unknown;
}

export interface NormalizedComment {
  externalCommentId: string | null;
  authorName: string | null;
  text: string;
  postedAt: string | null;
  likes: number | null;
  replyCount: number | null;
  permalink: string | null;
  rawJson: unknown;
}

export interface RefreshReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: RefreshRun["status"];
  platforms: Array<{
    platform: Platform;
    providerType: ProviderType | null;
    status: "ok" | "skipped" | "failed";
    reason: string | null;
    videosUpdated: number;
    commentsUpdated: number;
    newVideosDiscovered: number;
  }>;
  errors: string[];
}
