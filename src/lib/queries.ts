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
  PLATFORM_LABELS,
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
  aggregateEstimatedTrend,
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
import {
  apifyFallbackAllowedByConfig,
  getAdminPassword,
  getApifyToken,
  getCronSecret,
  getSocialcrawlDailyCreditCap,
  getSocialcrawlKey,
  getYouTubeApiKey,
  isMockMode,
  isSocialcrawlEnabled,
  metricsProviderFor,
} from "./config";
import { computeMilestones, type Milestone, type MilestoneInput } from "./milestones";
import {
  decodeRunMode,
  getRefreshPolicyConfig,
  isQuietHours,
  localDateKey,
  nextActiveTime,
  socialcrawlCreditsToday,
} from "./refresh-policy";
import { readThumbState } from "./thumbnail-state";
import { resolveViews } from "./apify/view-resolver";
import {
  eligibilityFloorForCampaign,
  ineligibilityReason,
  isCampaignEligible,
  isReviewCandidate,
  INELIGIBILITY_LABELS,
  UNASSIGNED_EPISODE_NAME,
  type IneligibilityReason,
} from "./eligibility";
import {
  matchesCampaign,
  videoCampaign,
  videoTrackingStatus,
  type CampaignFilter,
  type CampaignSlug,
  type TrackingStatus,
} from "./campaigns";
import { summarizeCredits, tierSplit, type CreditSummary, type TierSplit } from "./credit-policy";
import { resolveCreditCap, type CapOverride } from "./credit-cap";

export type TimeRange = "24h" | "7d" | "30d" | "all";

export interface PlatformHealth {
  platform: Platform;
  providerType: ProviderType;
  sourceStatus: SourceStatus;
  statusDetail: string | null;
  lastSuccessfulRefreshAt: string | null;
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

/**
 * Cheap open-alert count for the sidebar notification badge. Deliberately does
 * NOT seed or resolve providers — just counts open alerts. Resilient: any error
 * (or no DB) returns 0 so the layout never breaks.
 */
export async function getOpenAlertCount(): Promise<number> {
  try {
    const store = getStore();
    const open = await store.listAlerts("open");
    return open.length;
  } catch {
    return 0;
  }
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

export interface PublicPlatformHealth {
  platform: Platform;
  sourceStatus: SourceStatus;
  lastSuccessfulRefreshAt: string | null;
  supportsComments: boolean;
  supportsDiscovery: boolean;
}

export interface PublicHealthSummary {
  store: { kind: StoreInfo["kind"] };
  mockMode: boolean;
  anyLive: boolean;
  platforms: PublicPlatformHealth[];
  lastRun: { status: string; startedAt: string; finishedAt: string | null } | null;
}

/**
 * Public, no-auth projection of the health summary for the /api/status badge.
 * Deliberately drops every internal/vendor field — the data vendor
 * (providerType), Apify actor ids, free-text status detail, and raw run logs
 * must never reach an unauthenticated surface. Pure + unit-tested.
 */
export function toPublicHealth(health: HealthSummary): PublicHealthSummary {
  return {
    store: { kind: health.store.kind },
    mockMode: health.mockMode,
    anyLive: health.anyLive,
    platforms: health.platforms.map((p) => ({
      platform: p.platform,
      sourceStatus: p.sourceStatus,
      lastSuccessfulRefreshAt: p.lastSuccessfulRefreshAt,
      supportsComments: p.supportsComments,
      supportsDiscovery: p.supportsDiscovery,
    })),
    lastRun: health.lastRun
      ? {
          status: health.lastRun.status,
          startedAt: health.lastRun.startedAt,
          finishedAt: health.lastRun.finishedAt,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Shared loading
// ---------------------------------------------------------------------------

/** A page-facing video with its resolved campaign + tracking status attached
 *  (rawJson is stripped, so these derived fields carry the campaign signal). */
export type ScopedVideo = Video & { campaign: CampaignSlug | null; trackingStatus: TrackingStatus };

export interface CampaignData {
  campaign: Campaign;
  videos: ScopedVideo[];
  metricsByVideo: Map<string, VideoMetrics>;
  snapshotsByVideo: Map<string, MetricSnapshot[]>;
  episodes: EpisodeGroup[];
  profiles: PlatformProfile[];
}

export async function loadCampaignData(
  includeHidden = false,
  campaignFilter: CampaignFilter = "all",
  /** Admin contexts pass true to bypass the campaign filter so excluded /
   *  unassigned videos remain visible for management. */
  adminUnscoped = false,
): Promise<CampaignData> {
  const store = getStore();
  const campaign = await ensureSeedData(store);
  const episodes = await store.listEpisodeGroups();
  const unassignedId = episodes.find((e) => e.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;
  // Strip raw actor payloads before anything page-facing: client-component
  // props serialize into the public page payload, and rawJson contains
  // internal collector URLs (signed dataset links) and vendor field names.
  // Pipelines that need rawJson read the store directly.
  //
  // Campaign-eligibility filter (THE chokepoint): out-of-campaign / corrupt
  // records (e.g. SocialCrawl profile-feed imports with epoch dates) are
  // dropped here, so every downstream total/list/chart/milestone — which all
  // derive from this video set — excludes them automatically.
  const videos = (await store.listVideos({ includeHidden }))
    // Eligible AND not a pending discovery-review candidate (those stay out of
    // every public total until an admin promotes them from "Possible new content").
    // Campaign-aware floor: Bootcamp-tagged content is eligible back to the
    // Bootcamp start (April), MTL/untagged uses the later MTL start.
    .filter(
      (v) =>
        isCampaignEligible(v, eligibilityFloorForCampaign(videoCampaign(v)), unassignedId) &&
        !isReviewCandidate(v),
    )
    .map((v) => ({
      ...v,
      // Resolve campaign + tracking BEFORE stripping rawJson — these derived
      // fields carry the campaign signal to every downstream total/chart.
      campaign: videoCampaign(v),
      trackingStatus: videoTrackingStatus(v),
      rawJson: null,
      errorMessage: v.errorMessage
        ? v.errorMessage.replace(/apify|socialcrawl/gi, "collector")
        : null,
    }))
    // Campaign filter (THE second chokepoint): every downstream total/list/chart/
    // milestone derives from this set, so scoping here scopes the whole dashboard.
    // "all" excludes admin-excluded + explicitly-unassigned (campaign === null).
    // Admin contexts pass adminUnscoped to keep excluded/unassigned visible.
    // Defense-in-depth: on any non-admin path, removed-from-tracking videos are
    // dropped UNCONDITIONALLY (even under includeHidden:true, e.g. /alerts, and
    // even if a filter like "unassigned" would otherwise match a null campaign).
    .filter(
      (v) =>
        adminUnscoped || (v.trackingStatus !== "excluded" && matchesCampaign(v.campaign, campaignFilter)),
    );
  // Scope snapshots to the eligible video set too — otherwise the aggregate
  // trend (and periodDelta / velocity milestone / reports overallTrend, which
  // all read snapshotsByVideo) would still sum quarantined videos' snapshots
  // even though their video records are filtered out of every other total.
  const eligibleIds = new Set(videos.map((v) => v.id));
  const allSnaps = await store.listAllSnapshots();
  const snapshotsByVideo = new Map<string, MetricSnapshot[]>();
  for (const s of allSnaps) {
    if (!eligibleIds.has(s.videoId)) continue;
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
    episodes,
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

/** One campaign's combined-total figures for the breakdown card. */
export interface CampaignTotals {
  views: number | null;
  videos: number;
  pendingMetrics: number;
}
export interface CampaignBreakdown {
  all: CampaignTotals;
  bootcamp: CampaignTotals;
  mtl: CampaignTotals;
  /** Newest snapshot timestamp across all active campaigns. */
  lastUpdated: string | null;
}

export interface DashboardData {
  campaign: Campaign;
  health: HealthSummary;
  kpis: Kpis;
  /** All / Bootcamp / MTL combined totals (All === Bootcamp + MTL). Always the
   * full picture, independent of the page's current campaign filter. */
  campaignBreakdown: CampaignBreakdown;
  trend: TrendPoint[];
  /** Per-platform trend over the same buckets — feeds the chart tooltip's
   * platform breakdown and the growth-share narrative. */
  trendByPlatform: Partial<Record<Platform, TrendPoint[]>>;
  /** DISPLAY-ONLY estimated trend: each Bootcamp video ramps from publish→its first
   * snapshot, everything else is actual. Equal to `trend` for every bucket at/after
   * a video's first snapshot. Chart-only — never feeds KPIs / totals / reports /
   * periodDelta / milestones. */
  estimatedTrend: TrendPoint[];
  /** The latest first-snapshot across Bootcamp videos — the point after which the
   * estimated series is fully actual (footnote boundary). Null when none. */
  estimatedUntil: string | null;
  /** True when the estimated layer meaningfully differs from the real line. */
  hasEstimatedHistory: boolean;
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

/**
 * All / Bootcamp / MTL combined totals from a full ("all") campaign load. Views
 * sum each video's last-confirmed value (== the KPI total); All === Bootcamp + MTL
 * because every active video resolves to exactly one campaign. Display-only — the
 * estimated trend never feeds this.
 */
export function buildCampaignBreakdown(allData: CampaignData): CampaignBreakdown {
  const blank = (): { views: number | null; videos: number; pendingMetrics: number } => ({ views: null, videos: 0, pendingMetrics: 0 });
  const acc = { all: blank(), bootcamp: blank(), mtl: blank() };
  const add = (slot: { views: number | null; videos: number; pendingMetrics: number }, v: number | null) => {
    slot.videos += 1;
    if (v === null) slot.pendingMetrics += 1;
    else slot.views = (slot.views ?? 0) + v;
  };
  let lastUpdated: string | null = null;
  for (const v of allData.videos) {
    // Only campaign-assigned videos count — guarantees All === Bootcamp + MTL even
    // if a null-campaign (excluded/unassigned) row ever reaches this set.
    if (v.campaign !== "bootcamp" && v.campaign !== "mtl") continue;
    const views = allData.metricsByVideo.get(v.id)?.confirmed.views?.value ?? null;
    add(acc.all, views);
    if (v.campaign === "bootcamp") add(acc.bootcamp, views);
    else add(acc.mtl, views);
  }
  for (const snaps of allData.snapshotsByVideo.values()) {
    for (const s of snaps) if (lastUpdated === null || s.capturedAt > lastUpdated) lastUpdated = s.capturedAt;
  }
  return { ...acc, lastUpdated };
}

export async function getDashboardData(
  range: TimeRange = "7d",
  campaignFilter: CampaignFilter = "all",
): Promise<DashboardData> {
  const store = getStore();
  const data = await loadCampaignData(false, campaignFilter);
  // Full breakdown for the combined-total card — reuse `data` when already "all".
  const breakdownData = campaignFilter === "all" ? data : await loadCampaignData(false, "all");
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
  // Real series — feeds KPIs-adjacent display (periodDelta), the peak-growth
  // milestone, and the printable reports. The estimated layer below is computed
  // over the SAME window/buckets so it overlays 1:1, but the real trend is never
  // re-windowed by the estimate (that would shift milestones/reports).
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
  // DISPLAY-ONLY estimated trend (Bootcamp ramps from publish→its first snapshot;
  // everything else actual). Same window/buckets as `trend`, so it equals `trend`
  // for every bucket at/after each Bootcamp video's first snapshot. Consumed only
  // by the chart overlay — NEVER by KPIs / platform totals / reports / periodDelta /
  // milestones. Never writes snapshots.
  const bootcampVideos = videos.filter((v) => v.campaign === "bootcamp");
  const estimatedTrend = aggregateEstimatedTrend(
    videos.map((v) => ({ id: v.id, publishedAt: v.publishedAt, estimated: v.campaign === "bootcamp" })),
    snapshotsByVideo,
    from,
    now,
    bucketCount,
  );
  // Boundary (for the footnote): the LATEST first-snapshot across Bootcamp videos —
  // the point after which the estimated series is fully actual. Null when none.
  let estimatedUntil: string | null = null;
  for (const v of bootcampVideos) {
    let firstSnap: string | null = null;
    for (const s of snapshotsByVideo.get(v.id) ?? []) {
      if (firstSnap === null || s.capturedAt < firstSnap) firstSnap = s.capturedAt;
    }
    if (firstSnap && (estimatedUntil === null || firstSnap > estimatedUntil)) estimatedUntil = firstSnap;
  }
  // Expose the layer only when it VISIBLY differs from the real line in this window
  // (an actual ramp to show). Avoids a redundant dashed line + misleading footnote
  // on ranges where every Bootcamp video already has real data across the window.
  const hasEstimatedHistory =
    bootcampVideos.length > 0 && estimatedTrend.some((p, i) => p.views !== (trend[i]?.views ?? null));
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

  const videoById = new Map(videos.map((v) => [v.id, v]));
  // Scope comments to the campaign-filtered (and non-excluded) video set so
  // comment stats / response opportunities / recent comments never count
  // off-campaign or removed-from-tracking videos.
  const comments = (await store.listComments({ limit: 500 })).filter((c) => videoById.has(c.videoId));

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
    campaignBreakdown: buildCampaignBreakdown(breakdownData),
    historyStart: earliest,
    periodFastestGrowing,
    growthLeaders,
    trend,
    trendByPlatform,
    estimatedTrend,
    estimatedUntil,
    hasEstimatedHistory,
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

export async function getVideosPageData(
  range: TimeRange = "7d",
  campaign: CampaignFilter = "all",
): Promise<VideosPageData> {
  const store = getStore();
  // includeHidden:false — excluded (removed-from-tracking) videos never appear
  // on the public videos grid (they're hidden); the campaign filter scopes the rest.
  const data = await loadCampaignData(false, campaign);
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

/** A removed-from-tracking (admin-excluded) video, for the admin-only Removed
 *  view on the Videos page. Minimal, serializable shape — no rawJson. */
export interface RemovedVideoRow {
  id: string;
  platform: Platform;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  originalUrl: string;
  publishedAt: string | null;
  views: number | null;
  removedReason: string | null;
  removedAt: string | null;
}

/**
 * Admin-only: every video an admin has removed from tracking (soft-excluded),
 * newest-removed first. Uses the admin-unscoped load so excluded videos (which
 * every public query drops) are visible, then reads the removal reason/time from
 * the store record. Never called on a public path.
 */
export async function getRemovedVideosForAdmin(): Promise<RemovedVideoRow[]> {
  const store = getStore();
  // Unscoped + includeHidden so excluded videos survive both chokepoints.
  const data = await loadCampaignData(true, "all", true);
  const removed = data.videos.filter((v) => v.trackingStatus === "excluded");
  if (removed.length === 0) return [];
  // rawJson was stripped in loadCampaignData; re-read the raw records once to
  // recover the removal reason/time recorded by trackingPatch.
  const rawById = new Map((await store.listVideos({ includeHidden: true })).map((v) => [v.id, v]));
  const rows: RemovedVideoRow[] = removed.map((v) => {
    const raw = rawById.get(v.id);
    const tracking =
      raw?.rawJson && typeof raw.rawJson === "object"
        ? ((raw.rawJson as Record<string, unknown>).tracking as
            | { reason?: string; excludedAt?: string; at?: string }
            | undefined)
        : undefined;
    return {
      id: v.id,
      platform: v.platform,
      title: v.title,
      caption: v.caption,
      thumbnailUrl: v.thumbnailUrl,
      originalUrl: v.originalUrl,
      publishedAt: v.publishedAt,
      views: data.metricsByVideo.get(v.id)?.confirmed.views?.value ?? null,
      removedReason: tracking?.reason ?? null,
      removedAt: tracking?.excludedAt ?? tracking?.at ?? null,
    };
  });
  return rows.sort((a, b) => (b.removedAt ?? "").localeCompare(a.removedAt ?? ""));
}

// ---------------------------------------------------------------------------
// Comments page
// ---------------------------------------------------------------------------

export interface CommentsPageData {
  campaign: Campaign;
  // rawJson is stripped — the public page never needs the raw provider payload.
  comments: Array<Omit<Comment, "rawJson"> & { video: Video | null; episodeName: string | null }>;
  videos: Video[];
  episodes: EpisodeGroup[];
}

export async function getCommentsPageData(campaign: CampaignFilter = "all"): Promise<CommentsPageData> {
  const store = getStore();
  const data = await loadCampaignData(false, campaign);
  const allComments = await store.listComments({ limit: 1000 });
  const videoById = new Map(data.videos.map((v) => [v.id, v]));
  const episodeById = new Map(data.episodes.map((e) => [e.id, e.name]));
  // Scope comments to the campaign-filtered video set (a comment whose video is
  // outside the active campaign/excluded is dropped — never an orphan row).
  return {
    campaign: data.campaign,
    comments: allComments
      .filter((c) => videoById.has(c.videoId))
      .map((c) => {
        const video = videoById.get(c.videoId) ?? null;
        const { rawJson: _rawJson, ...pub } = c; // never ship the raw provider payload publicly
        return {
          ...pub,
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

export async function getPlatformsPageData(campaign: CampaignFilter = "all"): Promise<PlatformsPageData> {
  const store = getStore();
  const data = await loadCampaignData(false, campaign);
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
  // Scope comment counts to the campaign-filtered video set (excludes
  // off-campaign + removed-from-tracking videos).
  const videoIds = new Set(data.videos.map((v) => v.id));
  const comments = (await store.listComments()).filter((c) => videoIds.has(c.videoId));
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
  videos: Array<ScopedVideo & { episodeName: string | null }>;
  episodes: EpisodeGroup[];
  refreshRuns: RefreshRun[];
  providerConfigs: ProviderConfig[];
  tokenStatus: ApifyTokenStatus;
  overrides: Awaited<ReturnType<ReturnType<typeof getStore>["listOverrides"]>>;
  /** Per-video field-completeness scores. */
  completeness: Record<string, Completeness>;
  /** Recent collection attempts (the provider attempt log). */
  attempts: CollectionAttempt[];
  /** All computed campaign milestones (uncapped) — admin diagnostics. */
  milestones: Milestone[];
  /** Per-video Facebook view-accuracy diagnostics (admin-only). */
  facebookDiagnostics: FacebookDiagnostic[];
  /** Review queue: records excluded by the campaign-eligibility filter (not
   *  counted anywhere) — e.g. old profile-feed imports with epoch dates. */
  quarantinedVideos: QuarantinedVideoDiag[];
  /** Discovery lane status (last/next pull, cadence, last-run candidate counts). */
  discovery: DiscoveryStatus;
  /** "Possible new content" — discovered-but-uncertain candidates pending an
   *  admin decision; not counted in any total until promoted. */
  reviewCandidates: QuarantinedVideoDiag[];
  /** Videos whose thumbnail is missing/pending-retry/failed (admin visibility). */
  thumbnailIssues: ThumbnailIssue[];
  /** SocialCrawl provider status + credit usage (admin-only, never the key). */
  socialcrawl: SocialcrawlAdminStatus;
  /** Option B credit policy: usage / projection / days-remaining (admin-only). */
  credits: CreditSummary;
  /** Hot / Warm / Bootcamp / excluded refresh-tier split + Bootcamp batch cost. */
  tierSplit: TierSplit;
  /** SocialCrawl cap: normal (env) vs today-only override (active value + expiry). */
  creditCapInfo: { baseCap: number; activeCap: number; override: CapOverride | null };
  /** Per-platform comment ingestion health (admin-only). */
  commentHealth: CommentHealthRow[];
  /** YouTube provider health — API vs Apify fallback (never the key value). */
  youtubeProvider: YouTubeProviderStatus;
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

export interface FacebookDiagnostic {
  videoId: string;
  title: string | null;
  /** Short slug of the reel URL (never a secret). */
  urlSlug: string;
  /** Best view value the resolver extracts from the latest rawJson. */
  resolvedViews: number | null;
  extractionPath: string | null;
  viewConfidence: string;
  rawDisplayValue: string | null;
  sourceSurface: string;
  /** Confirmed (last-known-good) view value the dashboard actually shows. */
  confirmedViews: number | null;
  manualVerified: boolean;
  stale: boolean;
  /** A lower automated value was rejected by monotonic protection this cycle. */
  monotonicPreserved: boolean;
  hasThumbnail: boolean;
  lastRefreshedAt: string | null;
  /** Other tracked FB videos sharing this reel's id/canonical URL (dupes). */
  duplicateCandidateIds: string[];
}

export interface ThumbnailIssue {
  videoId: string;
  platform: Platform;
  title: string | null;
  urlSlug: string;
  /** valid | missing | retry_pending | failed | placeholder */
  status: string;
  attempts: number;
  lastAttemptAt: string | null;
  failureReason: string | null;
}

export interface CommentHealthRow {
  platform: Platform;
  /** Where comment TEXT comes from: "SocialCrawl" (TT/IG/FB) or "YouTube Data API". */
  source: string;
  /** Comment text rows stored for this platform. */
  stored: number;
  /** Most recent stored comment (postedAt, else capturedAt). */
  lastCommentAt: string | null;
  /** Latest comment-pull attempt (SocialCrawl comments tier) — null for YouTube,
   *  whose comments ride the metrics run rather than a separate logged attempt. */
  lastPullAt: string | null;
  lastReturned: number | null;
  lastPullOk: boolean | null;
  failuresToday: number;
  /** SocialCrawl comment credits spent today (1/call); 0 for YouTube (free API). */
  creditsToday: number;
}

export interface DiscoveryStatus {
  enabled: boolean;
  cadenceHours: number;
  lookbackHours: number;
  lastPullAt: string | null;
  nextPullAt: string | null;
  quietHours: boolean;
  /** Candidate counts from the most recent discovery run (parsed from its log). */
  lastRun: { at: string; added: number; review: number; ignored: number; healed: number } | null;
  pendingReview: number;
}

export interface QuarantinedVideoDiag {
  videoId: string;
  platform: Platform;
  title: string | null;
  thumbnailUrl: string | null;
  /** Path-only slug of the URL (never a secret). */
  urlSlug: string;
  /** The publishedAt value stored on the record (ISO, may be the epoch date). */
  publishedAtStored: string | null;
  /** The raw provider timestamp before parsing (e.g. the Unix-seconds number). */
  rawPublishedAt: string | null;
  /** publishedAtStored re-parsed to ISO, or null if unparseable. */
  publishedAtParsed: string | null;
  reason: IneligibilityReason;
  reasonLabel: string;
  /** Provenance bucket — "socialcrawl" | "other" | "collector" (never a vendor name). */
  source: "socialcrawl" | "other" | "collector";
  episodeName: string | null;
}

export interface SocialcrawlAdminStatus {
  /** Key present (presence only — value never exposed). */
  configured: boolean;
  /** Master switch + key both satisfied → SocialCrawl is the active primary. */
  enabled: boolean;
  creditsToday: number;
  dailyCap: number;
  calls: number;
  cached: number;
  failed: number;
  apifyFallbackAvailable: boolean;
  /** Apify fallback explicitly enabled (off by default now SocialCrawl is primary). */
  apifyFallbackEnabled: boolean;
  /** Apify actor runs recorded today (should be 0 while disabled). */
  apifyCallsToday: number;
  /** Estimated Apify spend today (USD). */
  apifyEstSpendToday: number;
  /** Active metrics provider per non-YouTube platform. */
  providerByPlatform: Record<"tiktok" | "instagram" | "facebook", "socialcrawl" | "apify">;
  /** Facebook view source for the public dashboard. */
  facebookViewSource: "socialcrawl_public_plays" | "apify_viewscount";
}

export interface YouTubeProviderStatus {
  /** Which provider serves YouTube right now. */
  mode: "youtube_api" | "apify_fallback";
  /** True when YOUTUBE_API_KEY is set (presence only — value never exposed). */
  keyConfigured: boolean;
  lastApiSuccessAt: string | null;
  lastApiFailureAt: string | null;
  lastApiError: string | null;
  /** Videos returned by the most recent successful YouTube API sweep. */
  videosViaApiLastRun: number;
  /** True when the Apify YouTube scraper ran recently (fallback path used). */
  apifyFallbackUsedRecently: boolean;
}

/**
 * Build the (pure, serializable) milestone-engine input from already-loaded
 * dashboard data. Shared by the public dashboard and the admin diagnostics so
 * both compute identical milestones. Per-platform period growth is first→last
 * confirmed views in the platform trend (same basis as periodDelta).
 */
export function dashboardMilestoneInput(data: DashboardData, rangeLabel: string): MilestoneInput {
  const platformGrowth = (platform: Platform): number | null => {
    const vals = (data.trendByPlatform[platform] ?? [])
      .map((p) => p.views)
      .filter((v): v is number => v !== null);
    return vals.length >= 2 ? vals[vals.length - 1] - vals[0] : null;
  };
  const top = data.leaderboard.mostViewed[0] ?? null;
  return {
    totalViews: data.kpis.totalViews,
    totalEngagements: data.kpis.totalEngagements,
    totalComments: data.kpis.totalComments,
    periodViewsGained: data.periodDelta.views,
    rangeLabel,
    platforms: data.platformStats.map((s) => ({
      platform: s.platform,
      label: PLATFORM_LABELS[s.platform],
      views: s.views,
      viewsGained: platformGrowth(s.platform),
    })),
    topVideo: top
      ? {
          title: top.video.title ?? "Top video",
          platform: top.video.platform,
          views: top.confirmed.views?.value ?? top.latest?.views ?? null,
        }
      : null,
    trend: data.trend.map((p) => ({ t: p.t, views: p.views })),
    topConcept: null,
  };
}

export async function getAdminPageData(): Promise<AdminPageData> {
  const store = getStore();
  // Unscoped: admin manages ALL videos — every campaign, plus unassigned and
  // excluded (removed-from-tracking) records.
  const data = await loadCampaignData(true, "all", true);
  const episodeById = new Map(data.episodes.map((e) => [e.id, e.name]));
  const health = await getHealth();
  // Full (uncapped) milestone list for admin diagnostics — lifetime view.
  const milestones = computeMilestones(
    dashboardMilestoneInput(await getDashboardData("all"), "all time"),
  );

  // Facebook view-accuracy diagnostics (admin-only). Runs the view resolver on
  // each FB video's stored rawJson and pairs it with the confirmed value the
  // dashboard shows. Only resolved values/paths are exposed — never rawJson.
  const fbRawVideos = (await store.listVideos({ includeHidden: true })).filter(
    (v) => v.platform === "facebook" && !v.hidden,
  );
  const fbKeyToIds = new Map<string, string[]>();
  for (const v of fbRawVideos) {
    for (const k of [v.externalVideoId, v.originalUrl].filter(Boolean) as string[]) {
      fbKeyToIds.set(k, [...(fbKeyToIds.get(k) ?? []), v.id]);
    }
  }
  const facebookDiagnostics: FacebookDiagnostic[] = fbRawVideos.map((v) => {
    const res =
      v.rawJson && typeof v.rawJson === "object"
        ? resolveViews(v.rawJson as Record<string, unknown>, "facebook")
        : ({ value: null, extractionPath: null, confidence: "none", sourceSurface: "unknown", rawDisplayValue: null } as const);
    const confirmed = data.metricsByVideo.get(v.id)?.confirmed.views ?? null;
    const snaps = (data.snapshotsByVideo.get(v.id) ?? [])
      .slice()
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const latest = snaps[snaps.length - 1] ?? null;
    const dupes = new Set<string>();
    for (const k of [v.externalVideoId, v.originalUrl].filter(Boolean) as string[]) {
      for (const id of fbKeyToIds.get(k) ?? []) if (id !== v.id) dupes.add(id);
    }
    return {
      videoId: v.id,
      title: v.title ?? v.caption ?? null,
      urlSlug: (v.originalUrl ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 48),
      resolvedViews: res.value,
      extractionPath: res.extractionPath,
      viewConfidence: res.confidence,
      rawDisplayValue: res.rawDisplayValue,
      sourceSurface: res.sourceSurface,
      confirmedViews: confirmed?.value ?? null,
      manualVerified: confirmed?.manual ?? false,
      stale: confirmed?.stale ?? false,
      monotonicPreserved: Boolean(latest && latest.views === null && confirmed?.value != null),
      hasThumbnail: Boolean(v.thumbnailUrl),
      lastRefreshedAt: v.lastRefreshedAt,
      duplicateCandidateIds: [...dupes],
    };
  });
  // Review queue: records EXCLUDED by the eligibility filter (e.g. old profile-
  // feed imports with epoch dates). Read raw store rows so we can surface the
  // provider source + raw timestamp (loadCampaignData filters these out and
  // strips rawJson). Hidden records are dropped — admin "Hide" clears the queue.
  const unassignedIdAdmin = data.episodes.find((e) => e.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;
  const quarantinedVideos: QuarantinedVideoDiag[] = (await store.listVideos({ includeHidden: true }))
    .filter((v) => !v.hidden)
    // Campaign-aware floor: a Bootcamp-tagged April video is eligible (not quarantined).
    .map((v) => ({ v, reason: ineligibilityReason(v, eligibilityFloorForCampaign(videoCampaign(v)), unassignedIdAdmin) }))
    .filter((x): x is { v: Video; reason: IneligibilityReason } => x.reason !== null)
    .map(({ v, reason }) => {
      const rawPost =
        v.rawJson && typeof v.rawJson === "object"
          ? (v.rawJson as { source?: unknown; post?: { published_at?: unknown } })
          : null;
      const rawTs = rawPost?.post?.published_at;
      let parsed: string | null = null;
      if (v.publishedAt) {
        const t = Date.parse(v.publishedAt);
        parsed = Number.isNaN(t) ? null : new Date(t).toISOString();
      }
      const src = typeof rawPost?.source === "string" ? rawPost.source : null;
      return {
        videoId: v.id,
        platform: v.platform,
        title: v.title ?? v.caption ?? null,
        thumbnailUrl: v.thumbnailUrl,
        urlSlug: (v.originalUrl ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 60),
        publishedAtStored: v.publishedAt,
        rawPublishedAt: rawTs == null ? null : String(rawTs),
        publishedAtParsed: parsed,
        reason,
        reasonLabel: INELIGIBILITY_LABELS[reason],
        source: src === "socialcrawl" ? "socialcrawl" : src ? "other" : "collector",
        episodeName: v.episodeGroupId ? (episodeById.get(v.episodeGroupId) ?? null) : null,
      };
    });

  // Discovery lane status + "Possible new content" review candidates.
  const REVIEW_LABELS: Record<string, string> = {
    older_than_discovery_window: "Posted before the auto-add window — confirm it's campaign content",
    no_stable_id: "No stable platform ID — confirm before adding",
    review: "Pending review",
  };
  const reviewRaw = (await store.listVideos({ includeHidden: true })).filter((v) => isReviewCandidate(v));
  const reviewCandidates: QuarantinedVideoDiag[] = reviewRaw.map((v) => {
    const rawPost =
      v.rawJson && typeof v.rawJson === "object"
        ? (v.rawJson as { source?: unknown; discoveryReviewReason?: unknown; post?: { published_at?: unknown } })
        : null;
    let parsed: string | null = null;
    if (v.publishedAt) {
      const t = Date.parse(v.publishedAt);
      parsed = Number.isNaN(t) ? null : new Date(t).toISOString();
    }
    const src = typeof rawPost?.source === "string" ? rawPost.source : null;
    const reason = typeof rawPost?.discoveryReviewReason === "string" ? rawPost.discoveryReviewReason : "review";
    return {
      videoId: v.id,
      platform: v.platform,
      title: v.title ?? v.caption ?? null,
      thumbnailUrl: v.thumbnailUrl,
      urlSlug: (v.originalUrl ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 60),
      publishedAtStored: v.publishedAt,
      rawPublishedAt: rawPost?.post?.published_at == null ? null : String(rawPost.post.published_at),
      publishedAtParsed: parsed,
      reason: "before_campaign_start" as IneligibilityReason, // placeholder; UI uses reasonLabel
      reasonLabel: REVIEW_LABELS[reason] ?? reason,
      source: src === "socialcrawl" ? "socialcrawl" : src ? "other" : "collector",
      episodeName: null,
    };
  });

  const policyCfg = getRefreshPolicyConfig();
  const discRuns = await store.listRefreshRuns(60);
  const lastDiscRun = discRuns.find(
    (r) => (r.status === "success" || r.status === "partial") && decodeRunMode(r)?.discovery,
  );
  let lastRunCounts: DiscoveryStatus["lastRun"] = null;
  if (lastDiscRun) {
    let added = 0,
      review = 0,
      ignored = 0,
      healed = 0;
    for (const line of lastDiscRun.rawLog ?? []) {
      const m = line.match(/discovery — added:(\d+) review:(\d+) ignored:(\d+)(?: healed:(\d+))?/);
      if (m) {
        added += Number(m[1]);
        review += Number(m[2]);
        ignored += Number(m[3]);
        healed += Number(m[4] ?? 0);
      }
    }
    lastRunCounts = { at: lastDiscRun.startedAt, added, review, ignored, healed };
  }
  const cadenceMin = policyCfg.discoveryIntervalMin;
  const lastPullAt = lastDiscRun?.startedAt ?? null;
  const nextPullAt = nextActiveTime(
    lastPullAt ? new Date(new Date(lastPullAt).getTime() + cadenceMin * 60_000) : new Date(),
    policyCfg,
  ).toISOString();
  const discovery: DiscoveryStatus = {
    enabled: policyCfg.enableDiscovery,
    cadenceHours: Math.round((cadenceMin / 60) * 10) / 10,
    lookbackHours: policyCfg.discoveryLookbackHours,
    lastPullAt,
    nextPullAt,
    quietHours: isQuietHours(new Date(), policyCfg),
    lastRun: lastRunCounts,
    pendingReview: reviewCandidates.length,
  };

  // Thumbnail retry visibility — videos still missing a usable thumbnail.
  const thumbnailIssues: ThumbnailIssue[] = (await store.listVideos({ includeHidden: true }))
    .filter((v) => !v.hidden && !isReviewCandidate(v))
    .map((v) => ({ v, t: readThumbState(v.rawJson) }))
    .filter(({ v, t }) => t.status === "retry_pending" || t.status === "failed" || (!v.thumbnailUrl && t.status !== "valid"))
    .map(({ v, t }) => ({
      videoId: v.id,
      platform: v.platform,
      title: v.title ?? v.caption ?? null,
      urlSlug: (v.originalUrl ?? "").replace(/^https?:\/\/[^/]+/, "").slice(0, 60),
      status: t.status,
      attempts: t.attempts,
      lastAttemptAt: t.lastAttemptAt,
      failureReason: t.failureReason,
    }));

  const allAttempts = (await store.listCollectionAttempts(200)).sort((a, b) =>
    b.capturedAt.localeCompare(a.capturedAt),
  );
  const ytApi = allAttempts.filter((a) => a.platform === "youtube" && a.provider === "youtube_api");
  const ytApiSuccess = ytApi.find((a) => a.success) ?? null;
  const ytApiFailure = ytApi.find((a) => !a.success) ?? null;
  const ytHealth = health.platforms.find((p) => p.platform === "youtube");
  const youtubeProvider: YouTubeProviderStatus = {
    mode: ytHealth?.providerType === "youtube_api" ? "youtube_api" : "apify_fallback",
    keyConfigured: getYouTubeApiKey() !== null,
    lastApiSuccessAt: ytApiSuccess?.capturedAt ?? null,
    lastApiFailureAt: ytApiFailure?.capturedAt ?? null,
    lastApiError: ytApiFailure?.error ?? null,
    videosViaApiLastRun: ytApiSuccess?.itemCount ?? 0,
    apifyFallbackUsedRecently: allAttempts.some(
      (a) => a.platform === "youtube" && a.provider === "apify",
    ),
  };

  // SocialCrawl status + credit usage (admin-only; the key is never exposed).
  const scTz = getRefreshPolicyConfig().quietTimezone;
  const scUsage = socialcrawlCreditsToday(allAttempts, new Date(), scTz);
  const fbProvider = metricsProviderFor("facebook");
  const scTodayKey = localDateKey(new Date(), scTz);
  const apifyCallsToday = allAttempts.filter(
    (a) => a.provider === "apify" && localDateKey(new Date(a.capturedAt), scTz) === scTodayKey,
  ).length;
  const socialcrawl: SocialcrawlAdminStatus = {
    configured: getSocialcrawlKey() !== null,
    enabled: isSocialcrawlEnabled(),
    creditsToday: scUsage.credits,
    dailyCap: getSocialcrawlDailyCreditCap(),
    calls: scUsage.calls,
    cached: scUsage.cached,
    failed: scUsage.failed,
    apifyFallbackAvailable: getApifyToken() !== null,
    apifyFallbackEnabled: apifyFallbackAllowedByConfig(),
    apifyCallsToday,
    apifyEstSpendToday: Math.round(apifyCallsToday * getRefreshPolicyConfig().estCostPerRunUsd * 100) / 100,
    providerByPlatform: {
      tiktok: metricsProviderFor("tiktok"),
      instagram: metricsProviderFor("instagram"),
      facebook: fbProvider,
    },
    facebookViewSource: fbProvider === "socialcrawl" ? "socialcrawl_public_plays" : "apify_viewscount",
  };

  // Option B credit policy + tier split (admin-only). A wider attempt window is
  // needed for the recent-daily-average + credits-remaining than the 200-row
  // display list above (a single active day is already ~270 attempts).
  const scPolicy = getRefreshPolicyConfig();
  const creditAttempts = await store.listCollectionAttempts(4000);
  // Today-only cap override (if active) raises the effective cap; the panel shows
  // both the normal (env) cap and the active value + expiry.
  const resolvedCap = await resolveCreditCap(store, new Date());
  const credits = summarizeCredits({
    attempts: creditAttempts,
    now: new Date(),
    tz: scTz,
    cap: resolvedCap.activeCap,
    activeStartHour: scPolicy.quietStartHour,
    activeEndHour: scPolicy.quietEndHour,
  });
  const creditCapInfo = { baseCap: resolvedCap.baseCap, activeCap: resolvedCap.activeCap, override: resolvedCap.override };
  const tierSplitData = tierSplit(
    data.videos.map((v) => ({
      platform: v.platform,
      campaign: v.campaign,
      excluded: v.trackingStatus === "excluded",
      publishedAt: v.publishedAt,
      firstTrackedAt: v.firstTrackedAt,
      lastRefreshedAt: v.lastRefreshedAt,
    })),
    new Date(),
  );

  // Comment ingestion health (admin-only). Text source: SocialCrawl for TT/IG/FB
  // (/{platform}/post/comments), YouTube Data API for YouTube. Counts come from
  // stored comments; pull status from the logged "comments" attempts (SocialCrawl).
  const allComments = await store.listComments({ limit: 5000 });
  const commentAttempts = allAttempts.filter((a) => a.kind === "comments");
  const commentHealth: CommentHealthRow[] = PLATFORMS.map((platform) => {
    const stored = allComments.filter((c) => c.platform === platform);
    const lastCommentAt =
      stored.map((c) => c.postedAt ?? c.capturedAt).filter(Boolean).sort().pop() ?? null;
    const atts = commentAttempts.filter((a) => a.platform === platform); // sorted desc already
    const last = atts[0] ?? null;
    const todayAtts = atts.filter((a) => localDateKey(new Date(a.capturedAt), scTz) === scTodayKey);
    return {
      platform,
      source: platform === "youtube" ? "YouTube Data API" : "SocialCrawl",
      stored: stored.length,
      lastCommentAt,
      lastPullAt: last?.capturedAt ?? null,
      lastReturned: last?.itemCount ?? null,
      lastPullOk: last ? last.success : null,
      failuresToday: todayAtts.filter((a) => !a.success).length,
      creditsToday: platform === "youtube" ? 0 : todayAtts.length,
    };
  });

  // Actor IDs are admin-only — read them from the persisted provider configs,
  // never from the (publicly served) health summary. Mirror the old behavior:
  // only platforms actually served by Apify surface an actor id.
  const providerConfigs = await store.listProviderConfigs();
  const actorIds = { tiktok: null, instagram: null, facebook: null, youtube: null } as Record<
    Platform,
    string | null
  >;
  for (const p of health.platforms) {
    if (p.providerType !== "apify") continue;
    actorIds[p.platform] = providerConfigs.find((c) => c.platform === p.platform)?.actorId ?? null;
  }
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
    providerConfigs,
    tokenStatus: await checkToken(),
    overrides: await store.listOverrides(30),
    completeness,
    attempts: allAttempts.slice(0, 40),
    milestones,
    facebookDiagnostics,
    quarantinedVideos,
    discovery,
    reviewCandidates,
    thumbnailIssues,
    socialcrawl,
    credits,
    tierSplit: tierSplitData,
    creditCapInfo,
    commentHealth,
    youtubeProvider,
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
