// View-model assembly for pages. Server-only. Pages call exactly one of these
// and render the result — keeps all aggregation logic testable and in one
// place.

import { getStore } from "./store";
import type { StoreInfo } from "./store/types";
import {
  type Alert,
  type Campaign,
  type CollectionAttempt,
  type Comment,
  type EpisodeGroup,
  type MetricSnapshot,
  type Platform,
  PLATFORMS,
  type PlatformProfile,
  type ProviderConfig,
  type ProviderType,
  type RefreshRun,
  type SourceStatus,
  type Video,
} from "./types";
import {
  DAY_MS,
  HOUR_MS,
  aggregateTrend,
  computeVideoMetrics,
  engagements,
  deltaOverWindow,
  isSparseTrend,
  isViewsFrozen,
  rankByConfirmedViews,
  sumNullable,
  type TrendPoint,
  type VideoMetrics,
} from "./metrics";
import { computeCompleteness, type Completeness } from "./completeness";
import {
  computeConfidence,
  computeInsights,
  platformFreshness,
  type DataConfidence,
  type FreshnessLevel,
} from "./executive";
import { ensureSeedData } from "./seed";
import {
  RANGE_MS,
  fastestGrowingInWindow,
  topGrowersInWindow,
  videoGrowthInWindow,
  viewSparkline,
} from "./range";
import { resolveAllProviders } from "./providers/registry";
import { checkToken, type ApifyTokenStatus } from "./apify/client";
import { getAdminPassword, getCronSecret, getYouTubeApiKey, isMockMode } from "./config";

export type TimeRange = "24h" | "7d" | "30d" | "all";

export interface PlatformHealth {
  platform: Platform;
  providerType: ProviderType;
  sourceStatus: SourceStatus;
  statusDetail: string | null;
  lastSuccessfulRefreshAt: string | null;
  actorId: string | null;
  supportsComments: boolean;
  supportsDiscovery: boolean;
}

export interface HealthSummary {
  store: StoreInfo;
  mockMode: boolean;
  platforms: PlatformHealth[];
  lastRun: RefreshRun | null;
  /** True when at least one platform is delivering live data. */
  anyLive: boolean;
}

export async function getHealth(): Promise<HealthSummary> {
  const store = getStore();
  await ensureSeedData(store);
  const providers = await resolveAllProviders(store);
  // Last MEANINGFUL run — skipped gate entries are bookkeeping, not refreshes.
  const runs = (await store.listRefreshRuns(10)).filter((r) => r.status !== "skipped");
  const platforms: PlatformHealth[] = PLATFORMS.map((p) => {
    const r = providers[p];
    return {
      platform: p,
      providerType: r.provider.providerType,
      sourceStatus: r.readiness.ready
        ? (r.config?.lastSuccessfulRefreshAt ? "live" : "waiting")
        : r.readiness.sourceStatus,
      statusDetail: r.readiness.detail,
      lastSuccessfulRefreshAt: r.config?.lastSuccessfulRefreshAt ?? null,
      actorId: r.provider.providerType === "apify" ? (r.config?.actorId ?? null) : null,
      supportsComments: r.provider.supportsComments,
      supportsDiscovery: r.provider.supportsDiscovery,
    };
  });
  return {
    store: store.info(),
    mockMode: isMockMode(),
    platforms,
    lastRun: runs[0] ?? null,
    anyLive: platforms.some((p) => p.sourceStatus === "live"),
  };
}

// ---------------------------------------------------------------------------
// Shared loading
// ---------------------------------------------------------------------------

export interface CampaignData {
  campaign: Campaign;
  videos: Video[];
  metricsByVideo: Map<string, VideoMetrics>;
  snapshotsByVideo: Map<string, MetricSnapshot[]>;
  episodes: EpisodeGroup[];
  profiles: PlatformProfile[];
}

export async function loadCampaignData(includeHidden = false): Promise<CampaignData> {
  const store = getStore();
  const campaign = await ensureSeedData(store);
  // Strip raw actor payloads before anything page-facing: client-component
  // props serialize into the public page payload, and rawJson contains
  // internal collector URLs (signed dataset links) and vendor field names.
  // Pipelines that need rawJson read the store directly.
  const videos = (await store.listVideos({ includeHidden })).map((v) => ({
    ...v,
    rawJson: null,
    errorMessage: v.errorMessage ? v.errorMessage.replace(/apify/gi, "collector") : null,
  }));
  const allSnaps = await store.listAllSnapshots();
  const snapshotsByVideo = new Map<string, MetricSnapshot[]>();
  for (const s of allSnaps) {
    const arr = snapshotsByVideo.get(s.videoId) ?? [];
    arr.push(s);
    snapshotsByVideo.set(s.videoId, arr);
  }
  const metricsByVideo = new Map<string, VideoMetrics>();
  for (const v of videos) {
    metricsByVideo.set(v.id, computeVideoMetrics(v, snapshotsByVideo.get(v.id) ?? []));
  }
  return {
    campaign,
    videos,
    metricsByVideo,
    snapshotsByVideo,
    episodes: await store.listEpisodeGroups(),
    profiles: await store.listProfiles(),
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface Kpis {
  totalViews: number | null;
  totalEngagements: number | null;
  totalLikes: number | null;
  totalComments: number | null;
  avgEngagementRate: number | null;
  videosTracked: number;
  viewsGained24h: number | null;
  fastestGrowing: { video: Video; gained24h: number } | null;
}

export interface PlatformStats {
  platform: Platform;
  videoCount: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  engagements: number | null;
  engagementRate: number | null;
  viewsGained24h: number | null;
  commentsGained24h: number | null;
  avgViewsPerVideo: number | null;
  bestVideo: { video: Video; views: number } | null;
  latestVideo: Video | null;
  sourceStatus: SourceStatus;
  lastSuccessfulRefreshAt: string | null;
}

export interface MomentumData {
  views10m: number | null;
  views1h: number | null;
  views24h: number | null;
  bestPlatformToday: { platform: Platform; gained: number } | null;
  newestVideo: Video | null;
  fastestGrowing: { video: Video; gained24h: number } | null;
  commentsPerHour: number | null;
}

/** Per-platform "what are we actually getting" line for the source panel. */
export interface SourceCapability {
  platform: Platform;
  /** e.g. "Live metrics + comments", "Live engagement · views unavailable" */
  summary: string;
  /** Specific gaps, e.g. ["views unavailable", "comments unavailable"] */
  gaps: string[];
  live: boolean;
  /** When this platform's metrics were last verified against the source. */
  verifiedAt: string | null;
  /** Metric freshness — distinct from "the refresh job ran". */
  freshness: FreshnessLevel;
  /** Public-safe delay note, e.g. "data may be delayed". */
  freshnessNote: string | null;
}

export function describeSourceCapability(
  ph: PlatformHealth,
  stats: PlatformStats | undefined,
  opts: { youtubeKeySet?: boolean } = {},
): SourceCapability {
  const live = ph.sourceStatus === "live";
  if (!live) {
    return {
      platform: ph.platform,
      summary: ph.statusDetail ?? "Not connected",
      gaps: ["not connected"],
      live: false,
      verifiedAt: ph.lastSuccessfulRefreshAt,
      freshness: ph.sourceStatus === "refresh_failed" ? "failed" : "stale",
      freshnessNote: null,
    };
  }
  const viewsUnavailable = stats !== undefined && stats.videoCount > 0 && stats.views === null;
  // The source delivers comment COUNTS even when it can't pull comment text
  // (e.g. Facebook posts scraper) — say so instead of "comments unavailable".
  const commentCountsAvailable =
    !ph.supportsComments && stats !== undefined && stats.comments != null;
  const gaps: string[] = [];
  if (viewsUnavailable) gaps.push("views unavailable");

  let commentsPart = "";
  if (ph.supportsComments) {
    commentsPart = " + comments";
  } else if (commentCountsAvailable) {
    commentsPart = " + comment counts";
  }
  if (!ph.supportsComments) {
    if (ph.platform === "youtube" && ph.providerType === "apify" && !opts.youtubeKeySet) {
      gaps.push("add YouTube API key for comments");
    } else if (!commentCountsAvailable) {
      gaps.push("comments unavailable");
    }
  }
  if (!ph.supportsDiscovery) gaps.push("discovery unavailable");

  let summary = (viewsUnavailable ? "Live engagement" : "Live metrics") + commentsPart;
  if (gaps.length > 0) summary += ` · ${gaps.join(" · ")}`;
  return {
    platform: ph.platform,
    summary,
    gaps,
    live: true,
    // Freshness defaults — getDashboardData overrides with computed values.
    verifiedAt: ph.lastSuccessfulRefreshAt,
    freshness: "high",
    freshnessNote: null,
  };
}

export interface DashboardData {
  campaign: Campaign;
  health: HealthSummary;
  kpis: Kpis;
  trend: TrendPoint[];
  /** Per-platform trend over the same buckets — feeds the chart tooltip's
   * platform breakdown and the growth-share narrative. */
  trendByPlatform: Partial<Record<Platform, TrendPoint[]>>;
  /** True when there's too little history for a meaningful line chart. */
  trendIsSparse: boolean;
  /** Gains across the selected range (first→last trend values). */
  periodDelta: { views: number | null; engagements: number | null; comments: number | null };
  sourceCapabilities: SourceCapability[];
  /** Plain-English data-confidence summary for the hero badge. */
  confidence: DataConfidence;
  /** Computed insight lines for the hero ("TikTok is driving the most views"). */
  insights: string[];
  /** Earliest snapshot timestamp — when tracked history actually begins. */
  historyStart: string | null;
  /** Fastest-growing video WITHIN the selected range (not fixed-24h). */
  periodFastestGrowing: { video: Video; gained: number } | null;
  /** Top-3 growth leaders within the selected range, with share of growth. */
  growthLeaders: Array<{
    video: Video;
    gained: number;
    sharePct: number;
    currentViews: number | null;
  }>;
  platformStats: PlatformStats[];
  leaderboard: {
    mostViewed: VideoMetrics[];
    fastestGrowing: VideoMetrics[];
    highestEngagement: VideoMetrics[];
    mostCommented: VideoMetrics[];
    newest: VideoMetrics[];
  };
  momentum: MomentumData;
  recentComments: Array<Comment & { video: Video | null }>;
  responseOpportunities: Array<Comment & { video: Video | null }>;
  commentStats: {
    total: number;
    questions: number;
    mentionsWachter: number;
    needsResponse: number;
    recruitingInterest: number;
    positive: number;
    neutral: number;
    negative: number;
    topTags: Array<{ tag: string; count: number }>;
  };
  openAlerts: Alert[];
  dateRange: { from: string | null; to: string };
}

function rangeToMs(range: TimeRange): number | null {
  switch (range) {
    case "24h": return DAY_MS;
    case "7d": return 7 * DAY_MS;
    case "30d": return 30 * DAY_MS;
    case "all": return null;
  }
}

export async function getDashboardData(range: TimeRange = "7d"): Promise<DashboardData> {
  const store = getStore();
  const data = await loadCampaignData();
  const health = await getHealth();
  const { videos, metricsByVideo, snapshotsByVideo, campaign } = data;
  const all = [...metricsByVideo.values()];

  const kpis = buildKpis(all);
  const platformStats = buildPlatformStats(data, health);

  const now = new Date();
  const ms = rangeToMs(range);
  const earliest = [...snapshotsByVideo.values()]
    .flat()
    .reduce<string | null>((min, s) => (min === null || s.capturedAt < min ? s.capturedAt : min), null);
  // Clamp the window to real snapshot history (minus a small lead-in) so the
  // chart never opens with days of empty dead space before tracking began.
  const requestedFrom = ms ? new Date(now.getTime() - ms) : earliest ? new Date(earliest) : new Date(now.getTime() - DAY_MS);
  const earliestFrom = earliest
    ? new Date(new Date(earliest).getTime() - 15 * 60 * 1000)
    : requestedFrom;
  const from = requestedFrom > earliestFrom ? requestedFrom : earliestFrom;
  const spanMs = now.getTime() - from.getTime();
  const bucketCount = Math.min(48, Math.max(12, Math.round(spanMs / (30 * 60 * 1000))));
  const trend = aggregateTrend(snapshotsByVideo, from, now, bucketCount);
  // Same buckets per platform so rows align 1:1 with the aggregate trend.
  const trendByPlatform: Partial<Record<Platform, TrendPoint[]>> = {};
  for (const platform of PLATFORMS) {
    const subset = new Map<string, MetricSnapshot[]>();
    for (const v of videos) {
      if (v.platform !== platform) continue;
      const snaps = snapshotsByVideo.get(v.id);
      if (snaps?.length) subset.set(v.id, snaps);
    }
    if (subset.size > 0) {
      trendByPlatform[platform] = aggregateTrend(subset, from, now, bucketCount);
    }
  }
  const trendWithData = trend.filter((p) => p.views !== null);
  const firstPoint = trendWithData[0] ?? null;
  const lastPoint = trendWithData[trendWithData.length - 1] ?? null;
  const periodDelta = {
    views:
      firstPoint?.views != null && lastPoint?.views != null && firstPoint !== lastPoint
        ? lastPoint.views - firstPoint.views
        : null,
    engagements:
      firstPoint?.engagements != null && lastPoint?.engagements != null && firstPoint !== lastPoint
        ? lastPoint.engagements - firstPoint.engagements
        : null,
    comments:
      firstPoint?.comments != null && lastPoint?.comments != null && firstPoint !== lastPoint
        ? lastPoint.comments - firstPoint.comments
        : null,
  };

  const sortBy = (fn: (m: VideoMetrics) => number | null) =>
    [...all].sort((a, b) => (fn(b) ?? -1) - (fn(a) ?? -1));

  const fastest = sortBy((m) => m.delta24h?.value ?? null).filter((m) => (m.delta24h?.value ?? 0) > 0);
  const fastestGrowing =
    fastest.length > 0 && fastest[0].delta24h
      ? { video: fastest[0].video, gained24h: fastest[0].delta24h.value }
      : null;

  const comments = await store.listComments({ limit: 500 });
  const videoById = new Map(videos.map((v) => [v.id, v]));

  const tagCounts = new Map<string, number>();
  for (const c of comments) for (const t of c.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);

  const commentTimes = comments
    .map((c) => c.postedAt ?? c.capturedAt)
    .filter((t) => new Date(t).getTime() > now.getTime() - DAY_MS);

  const RECRUITING_TAGS = new Set(["hiring", "job/career", "apply", "bootcamp", "apprenticeship"]);
  const recruitingInterest = comments.filter((c) =>
    c.tags.some((t) => RECRUITING_TAGS.has(t)),
  ).length;
  const responseOpportunities = comments
    .filter((c) => c.needsResponse)
    .slice(0, 5)
    .map((c) => ({ ...c, video: videoById.get(c.videoId) ?? null }));

  const visibleVideos = videos.filter((v) => !v.hidden);
  const growthLeaders = topGrowersInWindow(visibleVideos, snapshotsByVideo, from, 3);
  const periodFastestGrowing = fastestGrowingInWindow(visibleVideos, snapshotsByVideo, from);

  return {
    campaign,
    health,
    kpis: { ...kpis, fastestGrowing },
    historyStart: earliest,
    periodFastestGrowing,
    growthLeaders,
    trend,
    trendByPlatform,
    trendIsSparse: isSparseTrend(trend),
    periodDelta,
    sourceCapabilities: health.platforms.map((ph) => {
      const cap = describeSourceCapability(
        ph,
        platformStats.find((s) => s.platform === ph.platform),
        { youtubeKeySet: getYouTubeApiKey() !== null },
      );
      if (!cap.live) return cap;
      // Frozen check on the platform's top visible video: unchanged views
      // across recent refreshes = the source may be serving delayed data.
      const platformVideos = videos.filter((v) => v.platform === ph.platform);
      const top = platformVideos
        .map((v) => metricsByVideo.get(v.id))
        .filter((m): m is VideoMetrics => Boolean(m))
        .sort((a, b) => (b.confirmed.views?.value ?? -1) - (a.confirmed.views?.value ?? -1))[0];
      const frozen = top ? isViewsFrozen(snapshotsByVideo.get(top.video.id) ?? [], now) : false;
      const f = platformFreshness({
        failed: ph.sourceStatus === "refresh_failed",
        verifiedAt: ph.lastSuccessfulRefreshAt,
        topVideoFrozen: frozen,
        now,
      });
      return { ...cap, freshness: f.level, freshnessNote: f.note };
    }),
    confidence: computeConfidence(all),
    insights: computeInsights({
      videosTracked: all.length,
      platformsLive: health.platforms.filter((p) => p.sourceStatus === "live").length,
      platformStats,
      needsResponse: comments.filter((c) => c.needsResponse).length,
      discoveryEnabled: health.platforms.some(
        (p) => p.sourceStatus === "live" && p.supportsDiscovery,
      ),
    }),
    responseOpportunities,
    platformStats,
    leaderboard: {
      // Only videos with confirmed (current or last-confirmed) views compete —
      // never-confirmed videos don't rank as silent zeros.
      mostViewed: rankByConfirmedViews(all).slice(0, 10),
      fastestGrowing: fastest.slice(0, 10),
      highestEngagement: sortBy((m) => m.engagementRate).filter((m) => m.engagementRate !== null).slice(0, 10),
      mostCommented: sortBy((m) => m.latest?.comments ?? null).slice(0, 10),
      newest: [...all]
        .sort((a, b) =>
          (b.video.publishedAt ?? b.video.firstTrackedAt).localeCompare(
            a.video.publishedAt ?? a.video.firstTrackedAt,
          ),
        )
        .slice(0, 10),
    },
    momentum: {
      views10m: sumNullable(all.map((m) => m.delta10m?.value ?? null)),
      views1h: sumNullable(all.map((m) => m.delta1h?.value ?? null)),
      views24h: kpis.viewsGained24h,
      bestPlatformToday: bestPlatformToday(platformStats),
      newestVideo:
        [...videos].sort((a, b) =>
          (b.publishedAt ?? b.firstTrackedAt).localeCompare(a.publishedAt ?? a.firstTrackedAt),
        )[0] ?? null,
      fastestGrowing,
      commentsPerHour: commentTimes.length > 0 ? commentTimes.length / 24 : null,
    },
    recentComments: comments.slice(0, 12).map((c) => ({ ...c, video: videoById.get(c.videoId) ?? null })),
    commentStats: {
      total: comments.length,
      questions: comments.filter((c) => c.sentiment === "question").length,
      mentionsWachter: comments.filter((c) => c.tags.includes("wachter")).length,
      needsResponse: comments.filter((c) => c.needsResponse).length,
      recruitingInterest,
      positive: comments.filter((c) => c.sentiment === "positive").length,
      neutral: comments.filter((c) => c.sentiment === "neutral").length,
      negative: comments.filter((c) => c.sentiment === "negative").length,
      topTags: [...tagCounts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
    },
    openAlerts: (await store.listAlerts("open")).slice(0, 6),
    dateRange: { from: campaign.startDate, to: now.toISOString() },
  };
}

function buildKpis(all: VideoMetrics[]): Kpis {
  const er = all.map((m) => m.engagementRate).filter((r): r is number => r !== null);
  return {
    // Last-confirmed values: a metric the source skipped THIS refresh still
    // counts at its last confirmed reading instead of vanishing from totals.
    totalViews: sumNullable(all.map((m) => m.confirmed.views?.value ?? null)),
    totalEngagements: sumNullable(all.map((m) => m.engagements)),
    totalLikes: sumNullable(all.map((m) => m.confirmed.likes?.value ?? null)),
    totalComments: sumNullable(all.map((m) => m.confirmed.comments?.value ?? null)),
    avgEngagementRate: er.length > 0 ? er.reduce((a, b) => a + b, 0) / er.length : null,
    videosTracked: all.length,
    viewsGained24h: sumNullable(all.map((m) => m.delta24h?.value ?? null)),
    fastestGrowing: null, // filled by caller
  };
}

function bestPlatformToday(stats: PlatformStats[]): { platform: Platform; gained: number } | null {
  let best: { platform: Platform; gained: number } | null = null;
  for (const s of stats) {
    if (s.viewsGained24h === null) continue;
    if (!best || s.viewsGained24h > best.gained) best = { platform: s.platform, gained: s.viewsGained24h };
  }
  return best;
}

function buildPlatformStats(data: CampaignData, health: HealthSummary): PlatformStats[] {
  return PLATFORMS.map((platform) => {
    const vids = data.videos.filter((v) => v.platform === platform);
    const ms = vids.map((v) => data.metricsByVideo.get(v.id)).filter((m): m is VideoMetrics => Boolean(m));
    const views = sumNullable(ms.map((m) => m.confirmed.views?.value ?? null));
    const eng = sumNullable(ms.map((m) => m.engagements));
    const ph = health.platforms.find((p) => p.platform === platform);
    const withViews = ms.filter((m) => m.confirmed.views !== null);
    const best = [...withViews].sort(
      (a, b) => (b.confirmed.views?.value ?? 0) - (a.confirmed.views?.value ?? 0),
    )[0];
    return {
      platform,
      videoCount: vids.length,
      views,
      likes: sumNullable(ms.map((m) => m.confirmed.likes?.value ?? null)),
      comments: sumNullable(ms.map((m) => m.confirmed.comments?.value ?? null)),
      engagements: eng,
      engagementRate: eng !== null && views !== null && views > 0 ? eng / views : null,
      viewsGained24h: sumNullable(ms.map((m) => m.delta24h?.value ?? null)),
      commentsGained24h: sumNullable(
        ms.map((m) => {
          const snaps = data.snapshotsByVideo.get(m.video.id) ?? [];
          const d = snaps.length >= 2 ? deltaComments24h(snaps) : null;
          return d;
        }),
      ),
      avgViewsPerVideo: views !== null && withViews.length > 0 ? Math.round(views / withViews.length) : null,
      bestVideo:
        best && best.confirmed.views !== null
          ? { video: best.video, views: best.confirmed.views.value }
          : null,
      latestVideo:
        [...vids].sort((a, b) =>
          (b.publishedAt ?? b.firstTrackedAt).localeCompare(a.publishedAt ?? a.firstTrackedAt),
        )[0] ?? null,
      sourceStatus: ph?.sourceStatus ?? "waiting",
      lastSuccessfulRefreshAt: ph?.lastSuccessfulRefreshAt ?? null,
    };
  });
}

function deltaComments24h(snaps: MetricSnapshot[]): number | null {
  return deltaOverWindow(snaps, DAY_MS, "comments")?.value ?? null;
}

// ---------------------------------------------------------------------------
// Videos page
// ---------------------------------------------------------------------------

/** Per-video audience-signal rollup from real scraped comment rows. */
export interface VideoAudienceSignal {
  /** Comment rows we actually captured for this video. */
  capturedComments: number;
  /** Rows flagged needsResponse (question / negative / hiring intent). */
  needsResponse: number;
  /** Most common signal among this video's comments, or null. */
  topSignal: string | null;
}

export type VideoRowData = VideoMetrics & {
  episodeName: string | null;
  profileUrl: string | null;
  /** Views gained within the selected range (real snapshots; null if sparse). */
  periodGrowth: number | null;
  /** True when history spans the whole selected window. */
  periodCoversFull: boolean;
  /** Confirmed-view sparkline within the range (real points; null if sparse). */
  sparkline: number[] | null;
  /** Per-video audience signals from captured comments. */
  audience: VideoAudienceSignal;
};

export interface VideosPageData {
  campaign: Campaign;
  episodes: EpisodeGroup[];
  rows: VideoRowData[];
  range: TimeRange;
  rangeLabel: string;
  /** Earliest snapshot across all videos — when tracking history begins. */
  historyStart: string | null;
  /** Distinct live/connected platforms among tracked videos. */
  platformCount: number;
  /** Most recent successful per-video refresh time. */
  lastUpdatedAt: string | null;
}

const RANGE_LABELS: Record<TimeRange, string> = {
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  all: "all time",
};

/** Top comment signal: questions / response-worthy / recruiting / sentiment. */
function topCommentSignal(comments: Comment[]): string | null {
  if (comments.length === 0) return null;
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const recruiting = new Set(["hiring", "job/career", "apply", "bootcamp", "apprenticeship"]);
  for (const c of comments) {
    if (c.sentiment === "question") bump("Questions");
    if (c.tags.includes("wachter")) bump("Wachter mentions");
    if (c.tags.some((t) => recruiting.has(t))) bump("Recruiting interest");
    if (c.sentiment === "positive") bump("Positive");
    if (c.sentiment === "negative") bump("Negative");
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

export async function getVideosPageData(range: TimeRange = "7d"): Promise<VideosPageData> {
  const store = getStore();
  const data = await loadCampaignData(true);
  const episodeById = new Map(data.episodes.map((e) => [e.id, e.name]));
  const profileById = new Map(data.profiles.map((p) => [p.id, p.profileUrl]));

  // Per-video captured comments (real rows) → audience signals.
  const comments = await store.listComments({ limit: 2000 });
  const commentsByVideo = new Map<string, Comment[]>();
  for (const c of comments) {
    const arr = commentsByVideo.get(c.videoId) ?? [];
    arr.push(c);
    commentsByVideo.set(c.videoId, arr);
  }

  // Window: clamp to real snapshot history so the period never spans dead time.
  const now = new Date();
  const earliest =
    [...data.snapshotsByVideo.values()]
      .flat()
      .reduce<string | null>((min, s) => (min === null || s.capturedAt < min ? s.capturedAt : min), null);
  const ms = range === "all" ? null : RANGE_MS[range];
  const requestedFrom = ms ? new Date(now.getTime() - ms) : earliest ? new Date(earliest) : new Date(now.getTime() - RANGE_MS["7d"]);
  const earliestFrom = earliest ? new Date(new Date(earliest).getTime() - 15 * 60 * 1000) : requestedFrom;
  const from = requestedFrom > earliestFrom ? requestedFrom : earliestFrom;

  let lastUpdatedAt: string | null = null;
  const livePlatforms = new Set<string>();

  const rows: VideoRowData[] = data.videos.map((v) => {
    const snaps = data.snapshotsByVideo.get(v.id) ?? [];
    const growth = videoGrowthInWindow(snaps, from);
    const vComments = commentsByVideo.get(v.id) ?? [];
    if (v.lastRefreshedAt && (!lastUpdatedAt || v.lastRefreshedAt > lastUpdatedAt)) {
      lastUpdatedAt = v.lastRefreshedAt;
    }
    if (!v.hidden && v.sourceStatus === "live") livePlatforms.add(v.platform);
    return {
      ...data.metricsByVideo.get(v.id)!,
      episodeName: v.episodeGroupId ? (episodeById.get(v.episodeGroupId) ?? null) : null,
      profileUrl: v.profileId ? (profileById.get(v.profileId) ?? null) : null,
      periodGrowth: growth.gained,
      periodCoversFull: growth.coversFull,
      sparkline: viewSparkline(snaps, from),
      audience: {
        capturedComments: vComments.length,
        needsResponse: vComments.filter((c) => c.needsResponse).length,
        topSignal: topCommentSignal(vComments),
      },
    };
  });

  return {
    campaign: data.campaign,
    episodes: data.episodes,
    rows,
    range,
    rangeLabel: RANGE_LABELS[range],
    historyStart: earliest,
    platformCount: livePlatforms.size,
    lastUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Comments page
// ---------------------------------------------------------------------------

export interface CommentsPageData {
  campaign: Campaign;
  comments: Array<Comment & { video: Video | null; episodeName: string | null }>;
  videos: Video[];
  episodes: EpisodeGroup[];
}

export async function getCommentsPageData(): Promise<CommentsPageData> {
  const store = getStore();
  const data = await loadCampaignData();
  const comments = await store.listComments({ limit: 1000 });
  const videoById = new Map(data.videos.map((v) => [v.id, v]));
  const episodeById = new Map(data.episodes.map((e) => [e.id, e.name]));
  return {
    campaign: data.campaign,
    comments: comments.map((c) => {
      const video = videoById.get(c.videoId) ?? null;
      return {
        ...c,
        video,
        episodeName: video?.episodeGroupId ? (episodeById.get(video.episodeGroupId) ?? null) : null,
      };
    }),
    videos: data.videos,
    episodes: data.episodes,
  };
}

// ---------------------------------------------------------------------------
// Platforms page
// ---------------------------------------------------------------------------

export interface PlatformsPageData {
  campaign: Campaign;
  health: HealthSummary;
  stats: PlatformStats[];
  trendByPlatform: Record<Platform, TrendPoint[]>;
  commentCounts: Record<Platform, number>;
}

export async function getPlatformsPageData(): Promise<PlatformsPageData> {
  const store = getStore();
  const data = await loadCampaignData();
  const health = await getHealth();
  const now = new Date();
  const from = new Date(now.getTime() - 7 * DAY_MS);
  const trendByPlatform = {} as Record<Platform, TrendPoint[]>;
  for (const platform of PLATFORMS) {
    const map = new Map<string, MetricSnapshot[]>();
    for (const v of data.videos.filter((x) => x.platform === platform)) {
      map.set(v.id, data.snapshotsByVideo.get(v.id) ?? []);
    }
    trendByPlatform[platform] = aggregateTrend(map, from, now, 28);
  }
  const comments = await store.listComments();
  const commentCounts = { tiktok: 0, youtube: 0, instagram: 0, facebook: 0 } as Record<Platform, number>;
  for (const c of comments) commentCounts[c.platform]++;
  return {
    campaign: data.campaign,
    health,
    stats: buildPlatformStats(data, health),
    trendByPlatform,
    commentCounts,
  };
}

// ---------------------------------------------------------------------------
// Episodes page
// ---------------------------------------------------------------------------

export interface EpisodeStats {
  episode: EpisodeGroup;
  videos: VideoMetrics[];
  totalViews: number | null;
  totalEngagements: number | null;
  totalComments: number | null;
  avgEngagementRate: number | null;
  views24h: number | null;
  bestPlatform: Platform | null;
  topVideo: VideoMetrics | null;
  newestPostAt: string | null;
}

export interface EpisodesPageData {
  campaign: Campaign;
  episodes: EpisodeStats[];
  unassigned: VideoMetrics[];
  allEpisodes: EpisodeGroup[];
}

export async function getEpisodesPageData(): Promise<EpisodesPageData> {
  const data = await loadCampaignData();
  const stats: EpisodeStats[] = data.episodes.map((episode) => {
    const vids = data.videos.filter((v) => v.episodeGroupId === episode.id);
    const ms = vids.map((v) => data.metricsByVideo.get(v.id)!).filter(Boolean);
    const views = sumNullable(ms.map((m) => m.latest?.views ?? null));
    const eng = sumNullable(ms.map((m) => m.engagements));
    const byPlatform = new Map<Platform, number>();
    for (const m of ms) {
      if (m.latest?.views != null) {
        byPlatform.set(m.video.platform, (byPlatform.get(m.video.platform) ?? 0) + m.latest.views);
      }
    }
    const bestPlatform = [...byPlatform.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const er = ms.map((m) => m.engagementRate).filter((r): r is number => r !== null);
    return {
      episode,
      videos: ms,
      totalViews: views,
      totalEngagements: eng,
      totalComments: sumNullable(ms.map((m) => m.latest?.comments ?? null)),
      avgEngagementRate: er.length ? er.reduce((a, b) => a + b, 0) / er.length : null,
      views24h: sumNullable(ms.map((m) => m.delta24h?.value ?? null)),
      bestPlatform,
      topVideo: [...ms].sort((a, b) => (b.latest?.views ?? -1) - (a.latest?.views ?? -1))[0] ?? null,
      newestPostAt: vids
        .map((v) => v.publishedAt ?? v.firstTrackedAt)
        .sort()
        .reverse()[0] ?? null,
    };
  });
  return {
    campaign: data.campaign,
    episodes: stats,
    unassigned: data.videos
      .filter((v) => !v.episodeGroupId)
      .map((v) => data.metricsByVideo.get(v.id)!)
      .filter(Boolean),
    allEpisodes: data.episodes,
  };
}

// ---------------------------------------------------------------------------
// Alerts page
// ---------------------------------------------------------------------------

export interface AlertsPageData {
  campaign: Campaign;
  open: Array<Alert & { video: Video | null }>;
  reviewed: Array<Alert & { video: Video | null }>;
}

export async function getAlertsPageData(): Promise<AlertsPageData> {
  const store = getStore();
  const data = await loadCampaignData(true);
  const videoById = new Map(data.videos.map((v) => [v.id, v]));
  const attach = (a: Alert) => ({ ...a, video: a.videoId ? (videoById.get(a.videoId) ?? null) : null });
  return {
    campaign: data.campaign,
    open: (await store.listAlerts("open")).map(attach),
    reviewed: (await store.listAlerts("reviewed")).slice(0, 50).map(attach),
  };
}

// ---------------------------------------------------------------------------
// Admin page
// ---------------------------------------------------------------------------

export interface AdminPageData {
  campaign: Campaign;
  health: HealthSummary;
  profiles: PlatformProfile[];
  videos: Array<Video & { episodeName: string | null }>;
  episodes: EpisodeGroup[];
  refreshRuns: RefreshRun[];
  providerConfigs: ProviderConfig[];
  tokenStatus: ApifyTokenStatus;
  overrides: Awaited<ReturnType<ReturnType<typeof getStore>["listOverrides"]>>;
  /** Per-video field-completeness scores. */
  completeness: Record<string, Completeness>;
  /** Recent collection attempts (the provider attempt log). */
  attempts: CollectionAttempt[];
  /** Per-episode rollups for the admin Episodes manager. */
  episodeRollups: Array<{
    id: string;
    name: string;
    description: string | null;
    videoCount: number;
    totalViews: number | null;
    totalEngagements: number | null;
    totalComments: number | null;
  }>;
  /** Videos with no episode assignment (admin Episodes manager). */
  unassignedVideoCount: number;
  /** Production-readiness booleans (never the secret values themselves). */
  readiness: {
    databaseConnected: boolean;
    cronSecretSet: boolean;
    adminPasswordSet: boolean;
    actorIds: Record<Platform, string | null>;
    /** Average completeness across visible videos, 0–100. */
    avgCompleteness: number | null;
  };
}

export async function getAdminPageData(): Promise<AdminPageData> {
  const store = getStore();
  const data = await loadCampaignData(true);
  const episodeById = new Map(data.episodes.map((e) => [e.id, e.name]));
  const health = await getHealth();
  const actorIds = { tiktok: null, instagram: null, facebook: null, youtube: null } as Record<
    Platform,
    string | null
  >;
  for (const p of health.platforms) actorIds[p.platform] = p.actorId;
  const completeness: Record<string, Completeness> = {};
  for (const v of data.videos) {
    const m = data.metricsByVideo.get(v.id);
    if (m) completeness[v.id] = computeCompleteness(v, m);
  }
  const visibleScores = data.videos
    .filter((v) => !v.hidden)
    .map((v) => completeness[v.id]?.score)
    .filter((s): s is number => typeof s === "number");
  return {
    campaign: data.campaign,
    health,
    profiles: data.profiles,
    videos: data.videos.map((v) => ({
      ...v,
      episodeName: v.episodeGroupId ? (episodeById.get(v.episodeGroupId) ?? null) : null,
    })),
    episodes: data.episodes,
    episodeRollups: data.episodes.map((e) => {
      const members = data.videos.filter((v) => !v.hidden && v.episodeGroupId === e.id);
      let views: number | null = null;
      let eng: number | null = null;
      let comments: number | null = null;
      for (const v of members) {
        const m = data.metricsByVideo.get(v.id);
        if (!m?.latest) continue;
        if (m.latest.views !== null) views = (views ?? 0) + m.latest.views;
        if (m.latest.comments !== null) comments = (comments ?? 0) + m.latest.comments;
        const e2 = engagements(m.latest);
        if (e2 !== null) eng = (eng ?? 0) + e2;
      }
      return {
        id: e.id,
        name: e.name,
        description: e.description,
        videoCount: members.length,
        totalViews: views,
        totalEngagements: eng,
        totalComments: comments,
      };
    }),
    unassignedVideoCount: data.videos.filter((v) => !v.hidden && !v.episodeGroupId).length,
    refreshRuns: await store.listRefreshRuns(15),
    providerConfigs: await store.listProviderConfigs(),
    tokenStatus: await checkToken(),
    overrides: await store.listOverrides(30),
    completeness,
    attempts: await store.listCollectionAttempts(40),
    readiness: {
      databaseConnected: health.store.kind === "postgres",
      cronSecretSet: getCronSecret() !== null,
      adminPasswordSet: getAdminPassword() !== null,
      actorIds,
      avgCompleteness:
        visibleScores.length > 0
          ? Math.round(visibleScores.reduce((a, b) => a + b, 0) / visibleScores.length)
          : null,
    },
  };
}

export { HOUR_MS, DAY_MS };
