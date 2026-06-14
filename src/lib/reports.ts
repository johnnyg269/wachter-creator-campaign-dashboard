// Reports page data layer — CLIENT-SAFE half: types, filter/rollup constants,
// and PURE aggregation helpers shared by the server payload builder
// (lib/reports-data.ts), the client studio (instant re-filter), and the tests.
// This module imports NOTHING server-only (no store, no queries) so it can ship
// in the client bundle.
//
// Real data only: every metric traces back to a confirmed snapshot. Nulls mean
// "not reported" and are never coerced to 0 — aggregates return null when there
// is nothing real to sum, so a report never invents a number.

import type { TimeRange } from "./queries";
import { PLATFORMS, PLATFORM_LABELS, type Platform } from "./types";

export type ReportType = "executive" | "platforms" | "concepts" | "audience";
export type MetricFocus = "views" | "engagement" | "comments" | "growth";

export const REPORT_TYPES: Array<{ value: ReportType; label: string }> = [
  { value: "executive", label: "Executive Summary" },
  { value: "platforms", label: "Platform Breakdown" },
  { value: "concepts", label: "Content Concepts" },
  { value: "audience", label: "Audience Signals" },
];

export const METRIC_FOCUSES: Array<{ value: MetricFocus; label: string }> = [
  { value: "views", label: "Views" },
  { value: "engagement", label: "Engagement rate" },
  { value: "comments", label: "Comments" },
  { value: "growth", label: "Growth" },
];

export interface ReportFilters {
  range: TimeRange;
  /** Platform filter, or "all". */
  platform: Platform | "all";
  /** Content-concept (episode) id, or "all". */
  conceptId: string | "all";
  metric: MetricFocus;
  type: ReportType;
}

export const DEFAULT_FILTERS: ReportFilters = {
  range: "7d",
  platform: "all",
  conceptId: "all",
  metric: "views",
  type: "executive",
};

// ── Serializable payload rows ───────────────────────────────────────────────

export interface ReportVideo {
  id: string;
  platform: Platform;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  episodeId: string | null;
  episodeName: string | null;
  publishedAt: string | null;
  /** Confirmed (last-known-good) values; null = not reported. */
  views: number | null;
  engagements: number | null;
  engagementRate: number | null;
  comments: number | null;
  /** Views gained inside the selected range (null when history is sparse). */
  periodGrowth: number | null;
  periodCoversFull: boolean;
  /** True when the confirmed view value is older than the latest refresh. */
  stale: boolean;
  audienceCaptured: number;
  audienceNeedsResponse: number;
  audienceTopSignal: string | null;
}

export interface ReportComment {
  platform: Platform;
  episodeId: string | null;
  sentiment: "positive" | "neutral" | "negative" | "question" | null;
  needsResponse: boolean;
  recruiting: boolean;
  wachter: boolean;
}

export interface ReportPlatformHealth {
  platform: Platform;
  /** "live" | "stale" | "waiting" | … — display only, never the actor id. */
  sourceStatus: string;
  freshness: "high" | "partial" | "stale" | "failed";
  freshnessNote: string | null;
  lastSuccessfulRefreshAt: string | null;
}

export interface ReportTrendPoint {
  t: string;
  views: number | null;
  engagements: number | null;
  comments: number | null;
}

export interface ReportConcept {
  id: string;
  name: string;
}

export interface ReportsData {
  meta: {
    generatedAt: string;
    range: TimeRange;
    rangeLabel: string;
    historyStart: string | null;
    dateFrom: string | null;
    dateTo: string;
    /** Most recent successful refresh across all platforms (header timestamp). */
    lastSuccessfulRefreshAt: string | null;
    campaignName: string;
    creatorName: string;
    company: string;
  };
  confidence: { level: "high" | "partial" | "building"; headline: string; detail: string; verifiedAt: string | null };
  insights: string[];
  platforms: ReportPlatformHealth[];
  videos: ReportVideo[];
  concepts: ReportConcept[];
  comments: ReportComment[];
  overallTrend: ReportTrendPoint[];
  trendByPlatform: Partial<Record<Platform, ReportTrendPoint[]>>;
}

// ── Pure helpers (server + client + tests) ──────────────────────────────────

/** Sum real (non-null) numbers; null when nothing real was present. */
export function sumReal(values: Array<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v !== null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

export function filterVideos(
  videos: ReportVideo[],
  f: { platform: Platform | "all"; conceptId: string | "all" },
): ReportVideo[] {
  return videos.filter(
    (v) =>
      (f.platform === "all" || v.platform === f.platform) &&
      (f.conceptId === "all" || v.episodeId === f.conceptId),
  );
}

export function filterComments(
  comments: ReportComment[],
  f: { platform: Platform | "all"; conceptId: string | "all" },
): ReportComment[] {
  return comments.filter(
    (c) =>
      (f.platform === "all" || c.platform === f.platform) &&
      (f.conceptId === "all" || c.episodeId === f.conceptId),
  );
}

export interface VideoRollup {
  count: number;
  totalViews: number | null;
  totalEngagements: number | null;
  totalComments: number | null;
  /** Campaign-level engagement rate = totalEngagements / totalViews. */
  engagementRate: number | null;
  /** Views gained across the range (real period-growth readings only). */
  totalGrowth: number | null;
}

export function rollupVideos(videos: ReportVideo[]): VideoRollup {
  const totalViews = sumReal(videos.map((v) => v.views));
  const totalEngagements = sumReal(videos.map((v) => v.engagements));
  const totalComments = sumReal(videos.map((v) => v.comments));
  const totalGrowth = sumReal(videos.map((v) => v.periodGrowth));
  const engagementRate =
    totalViews !== null && totalViews > 0 && totalEngagements !== null
      ? totalEngagements / totalViews
      : null;
  return {
    count: videos.length,
    totalViews,
    totalEngagements,
    totalComments,
    engagementRate,
    totalGrowth,
  };
}

/** Value used to rank a video by the selected metric focus (null sorts last). */
export function metricValue(v: ReportVideo, metric: MetricFocus): number | null {
  switch (metric) {
    case "views": return v.views;
    case "engagement": return v.engagementRate;
    case "comments": return v.comments;
    case "growth": return v.periodGrowth;
  }
}

export function metricLabel(metric: MetricFocus): string {
  return METRIC_FOCUSES.find((m) => m.value === metric)?.label ?? "Views";
}

/** Rank videos by the focus metric, descending; videos with no real value drop out. */
export function rankVideos(videos: ReportVideo[], metric: MetricFocus): ReportVideo[] {
  return videos
    .filter((v) => metricValue(v, metric) !== null)
    .sort((a, b) => (metricValue(b, metric) ?? -1) - (metricValue(a, metric) ?? -1));
}

export interface PlatformRollup extends VideoRollup {
  platform: Platform;
  label: string;
}

/** Per-platform rollups for every platform that has at least one tracked video. */
export function rollupByPlatform(videos: ReportVideo[]): PlatformRollup[] {
  return PLATFORMS.map((platform) => {
    const vids = videos.filter((v) => v.platform === platform);
    return { platform, label: PLATFORM_LABELS[platform], ...rollupVideos(vids) };
  }).filter((r) => r.count > 0);
}

export interface ConceptRollup extends VideoRollup {
  id: string;
  name: string;
}

/** Per-concept rollups, plus an "Unassigned" bucket when any video lacks one. */
export function rollupConcepts(videos: ReportVideo[], concepts: ReportConcept[]): ConceptRollup[] {
  const rolls: ConceptRollup[] = concepts.map((c) => ({
    id: c.id,
    name: c.name,
    ...rollupVideos(videos.filter((v) => v.episodeId === c.id)),
  }));
  const unassigned = videos.filter((v) => !v.episodeId);
  if (unassigned.length > 0) {
    rolls.push({ id: "__unassigned", name: "Unassigned", ...rollupVideos(unassigned) });
  }
  return rolls.filter((r) => r.count > 0);
}

export interface CommentRollup {
  total: number;
  positive: number;
  neutral: number;
  negative: number;
  questions: number;
  needsResponse: number;
  recruiting: number;
  wachter: number;
}

export function rollupComments(comments: ReportComment[]): CommentRollup {
  return {
    total: comments.length,
    positive: comments.filter((c) => c.sentiment === "positive").length,
    neutral: comments.filter((c) => c.sentiment === "neutral").length,
    negative: comments.filter((c) => c.sentiment === "negative").length,
    questions: comments.filter((c) => c.sentiment === "question").length,
    needsResponse: comments.filter((c) => c.needsResponse).length,
    recruiting: comments.filter((c) => c.recruiting).length,
    wachter: comments.filter((c) => c.wachter).length,
  };
}
