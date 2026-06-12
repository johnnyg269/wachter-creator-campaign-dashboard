// Executive-summary helpers: the data-confidence badge and the computed
// insight lines shown in the dashboard hero. Pure functions — unit tested.

import type { VideoMetrics } from "./metrics";
import type { PlatformStats } from "./queries";
import { PLATFORM_LABELS, type Platform } from "./types";
import { formatCompact } from "./format";

export interface DataConfidence {
  level: "high" | "partial" | "building";
  /** Short badge line, e.g. "High confidence". */
  headline: string;
  /** One-sentence plain-English explanation. */
  detail: string;
  /** Most recent successful metric capture across videos. */
  verifiedAt: string | null;
}

/**
 * Confidence is about VIEW counts (the number leadership quotes):
 *  high     — every tracked video has a current confirmed view count
 *  partial  — every video was confirmed at some point, but some are stale
 *             or a few metrics are unavailable
 *  building — videos exist without any confirmed views yet
 */
export function computeConfidence(metrics: VideoMetrics[]): DataConfidence {
  const tracked = metrics.filter((m) => !m.video.hidden);
  if (tracked.length === 0) {
    return {
      level: "building",
      headline: "Awaiting first data",
      detail: "Tracking starts with the first refresh.",
      verifiedAt: null,
    };
  }
  const neverConfirmed = tracked.filter((m) => m.confirmed.views === null);
  const stale = tracked.filter((m) => m.confirmed.views?.stale);
  const verifiedAt =
    tracked
      .map((m) => m.confirmed.views?.at)
      .filter((t): t is string => Boolean(t))
      .sort()
      .pop() ?? null;

  if (neverConfirmed.length > 0) {
    return {
      level: "building",
      headline: "Confidence building",
      detail: `${neverConfirmed.length} of ${tracked.length} videos awaiting confirmed view counts.`,
      verifiedAt,
    };
  }
  if (stale.length > 0) {
    return {
      level: "partial",
      headline: "Partial confidence",
      detail: `${stale.length} video${stale.length === 1 ? " has" : "s have"} views from a prior refresh; the rest are current.`,
      verifiedAt,
    };
  }
  return {
    level: "high",
    headline: "High confidence",
    detail: "All tracked videos have confirmed view counts.",
    verifiedAt,
  };
}

/** Short, real-data insight lines for the hero. Order = importance. */
export function computeInsights(input: {
  videosTracked: number;
  platformsLive: number;
  platformStats: PlatformStats[];
  needsResponse: number;
  discoveryEnabled: boolean;
}): string[] {
  const out: string[] = [];
  out.push(
    `${input.videosTracked} video${input.videosTracked === 1 ? "" : "s"} tracked across ${input.platformsLive} platform${input.platformsLive === 1 ? "" : "s"}`,
  );

  const byViews = [...input.platformStats]
    .filter((s) => s.views !== null)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  if (byViews.length > 0 && (byViews[0].views ?? 0) > 0) {
    out.push(
      `${PLATFORM_LABELS[byViews[0].platform as Platform]} is driving the most views (${formatCompact(byViews[0].views)})`,
    );
  }

  const byEr = [...input.platformStats]
    .filter((s) => s.engagementRate !== null && (s.views ?? 0) > 100)
    .sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0));
  if (byEr.length > 0 && byEr[0].platform !== byViews[0]?.platform) {
    out.push(
      `${PLATFORM_LABELS[byEr[0].platform as Platform]} has the strongest engagement rate (${((byEr[0].engagementRate ?? 0) * 100).toFixed(1)}%)`,
    );
  }

  if (input.needsResponse > 0) {
    out.push(
      `${input.needsResponse} audience comment${input.needsResponse === 1 ? "" : "s"} may deserve a response`,
    );
  }

  if (input.discoveryEnabled) {
    out.push("New posts are discovered automatically on refresh");
  }
  return out.slice(0, 4);
}

export type FreshnessLevel = "high" | "partial" | "stale" | "failed";

export interface PlatformFreshness {
  level: FreshnessLevel;
  /** Public-safe note, e.g. "data may be delayed". Null when high. */
  note: string | null;
}

/**
 * Per-platform metric freshness — distinct from "the refresh job ran":
 *  high    — source verified within 10 minutes and not suspiciously frozen
 *  partial — verified within 30 minutes, or fresh but the top video's views
 *            are frozen across refreshes (source likely serving delayed data)
 *  stale   — older than 30 minutes
 *  failed  — the platform's latest refresh failed
 */
export function platformFreshness(input: {
  failed: boolean;
  verifiedAt: string | null;
  topVideoFrozen: boolean;
  now?: Date;
}): PlatformFreshness {
  const now = input.now ?? new Date();
  if (input.failed) return { level: "failed", note: "latest refresh failed" };
  if (!input.verifiedAt) return { level: "stale", note: "not verified yet" };
  const ageMin = (now.getTime() - new Date(input.verifiedAt).getTime()) / 60_000;
  if (ageMin > 30) return { level: "stale", note: "data may be delayed" };
  if (input.topVideoFrozen) {
    return { level: "partial", note: "metrics unchanged across recent refreshes — possibly delayed source" };
  }
  if (ageMin > 10) return { level: "partial", note: null };
  return { level: "high", note: null };
}
