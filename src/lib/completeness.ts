// Field-completeness scoring per video: how much of the data we want do we
// actually have (using last-confirmed values, so a single missed scrape
// doesn't zero the score).

import type { Video } from "./types";
import type { VideoMetrics } from "./metrics";

export interface Completeness {
  /** 0–100. */
  score: number;
  missingFields: string[];
  /** Fields counted for this platform. */
  totalFields: number;
}

/**
 * Required fields. `shares` only counts on platforms that expose it
 * (YouTube's API never reports shares — don't punish the score for it).
 */
export function computeCompleteness(
  video: Video,
  metrics: VideoMetrics,
  opts: { sharesSupported?: boolean } = {},
): Completeness {
  const sharesSupported = opts.sharesSupported ?? video.platform !== "youtube";
  const checks: Array<[string, boolean]> = [
    ["views", metrics.confirmed.views !== null],
    ["likes", metrics.confirmed.likes !== null],
    ["comments count", metrics.confirmed.comments !== null],
    ...(sharesSupported
      ? ([["shares", metrics.confirmed.shares !== null]] as Array<[string, boolean]>)
      : []),
    ["thumbnail", Boolean(video.thumbnailUrl)],
    ["title/caption", Boolean(video.title || video.caption)],
    ["published date", Boolean(video.publishedAt)],
    ["original URL", Boolean(video.originalUrl && !video.originalUrl.startsWith("unknown:"))],
    ["external video ID", Boolean(video.externalVideoId)],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([name]) => name);
  const score = Math.round(((checks.length - missing.length) / checks.length) * 100);
  return { score, missingFields: missing, totalFields: checks.length };
}
