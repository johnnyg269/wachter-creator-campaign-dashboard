// Reports page data layer — SERVER-ONLY half. Assembles a single PUBLIC-SAFE,
// fully-serializable payload (no rawJson, no actor IDs, no vendor names) from
// the existing range-aware queries. Imports the store-backed queries, so it must
// never be pulled into a client bundle — only the server `page.tsx` and tests
// import it. The client studio imports types + pure helpers from "./reports".

import { getDashboardData, getEpisodesPageData, getVideosPageData, getCommentsPageData } from "./queries";
import type { TimeRange } from "./queries";
import { PLATFORMS, type Platform } from "./types";
import type {
  ReportComment,
  ReportConcept,
  ReportPlatformHealth,
  ReportTrendPoint,
  ReportVideo,
  ReportsData,
} from "./reports";

const RECRUITING_TAGS = new Set(["hiring", "job/career", "apply", "bootcamp", "apprenticeship"]);

/**
 * Build the full reports payload at the given range. Composes the existing
 * range-aware queries and maps everything down to public-safe primitives.
 */
export async function buildReportsData(range: TimeRange): Promise<ReportsData> {
  const [dashboard, videosPage, episodesPage, commentsPage] = await Promise.all([
    getDashboardData(range),
    getVideosPageData(range),
    getEpisodesPageData(),
    getCommentsPageData(),
  ]);

  const videos: ReportVideo[] = videosPage.rows
    .filter((r) => !r.video.hidden)
    .map((r) => ({
      id: r.video.id,
      platform: r.video.platform,
      title: r.video.title ?? r.video.caption ?? "Untitled post",
      url: r.video.originalUrl,
      thumbnailUrl: r.video.thumbnailUrl,
      episodeId: r.video.episodeGroupId,
      episodeName: r.episodeName,
      publishedAt: r.video.publishedAt,
      views: r.confirmed.views?.value ?? null,
      engagements: r.engagements,
      engagementRate: r.engagementRate,
      comments: r.confirmed.comments?.value ?? null,
      periodGrowth: r.periodGrowth,
      periodCoversFull: r.periodCoversFull,
      stale: Boolean(r.confirmed.views?.stale),
      audienceCaptured: r.audience.capturedComments,
      audienceNeedsResponse: r.audience.needsResponse,
      audienceTopSignal: r.audience.topSignal,
    }));

  const comments: ReportComment[] = commentsPage.comments.map((c) => ({
    platform: c.platform,
    episodeId: c.video?.episodeGroupId ?? null,
    sentiment: c.sentiment,
    needsResponse: c.needsResponse,
    recruiting: c.tags.some((t) => RECRUITING_TAGS.has(t)),
    wachter: c.tags.includes("wachter"),
  }));

  const concepts: ReportConcept[] = episodesPage.allEpisodes.map((e) => ({ id: e.id, name: e.name }));

  const freshnessByPlatform = new Map(dashboard.sourceCapabilities.map((c) => [c.platform, c]));
  const platforms: ReportPlatformHealth[] = dashboard.health.platforms.map((p) => {
    const cap = freshnessByPlatform.get(p.platform);
    return {
      platform: p.platform,
      sourceStatus: p.sourceStatus,
      freshness: cap?.freshness ?? "stale",
      freshnessNote: cap?.freshnessNote ?? null,
      lastSuccessfulRefreshAt: p.lastSuccessfulRefreshAt,
    };
  });

  const toTrend = (pts: ReportTrendPoint[] | undefined): ReportTrendPoint[] =>
    (pts ?? []).map((p) => ({ t: p.t, views: p.views, engagements: p.engagements, comments: p.comments }));
  const trendByPlatform: Partial<Record<Platform, ReportTrendPoint[]>> = {};
  for (const platform of PLATFORMS) {
    trendByPlatform[platform] = toTrend(dashboard.trendByPlatform[platform]);
  }

  return {
    meta: {
      // Stamped by the server render; not Date.now() in a component body.
      generatedAt: new Date().toISOString(),
      range,
      rangeLabel: videosPage.rangeLabel,
      historyStart: dashboard.historyStart,
      dateFrom: dashboard.dateRange.from,
      dateTo: dashboard.dateRange.to,
      campaignName: dashboard.campaign.name,
      creatorName: dashboard.campaign.creatorName,
      company: dashboard.campaign.company,
    },
    confidence: {
      level: dashboard.confidence.level,
      headline: dashboard.confidence.headline,
      detail: dashboard.confidence.detail,
      verifiedAt: dashboard.confidence.verifiedAt,
    },
    insights: dashboard.insights,
    platforms,
    videos,
    concepts,
    comments,
    overallTrend: toTrend(dashboard.trend),
    trendByPlatform,
  };
}
