// Metric math. Core rule: null means "platform did not expose this metric".
// Null is never coerced to 0 — sums skip nulls, and an all-null sum is null.

import type { MetricSnapshot, Video } from "./types";

/** Sum of non-null values; null when every input is null/undefined. */
export function sumNullable(values: Array<number | null | undefined>): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v !== null && v !== undefined) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

/**
 * Engagements = likes + comments + shares + saves/bookmarks (when available).
 * Null when none of the components are available.
 */
export function engagements(s: {
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  bookmarks: number | null;
}): number | null {
  return sumNullable([s.likes, s.comments, s.shares, s.saves, s.bookmarks]);
}

/** Engagements / views. Null when either side is unavailable or views is 0. */
export function engagementRate(s: {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  bookmarks: number | null;
}): number | null {
  const e = engagements(s);
  if (e === null || s.views === null || s.views <= 0) return null;
  return e / s.views;
}

export type MetricField = "views" | "likes" | "comments" | "shares" | "saves" | "bookmarks";

/** Snapshots sorted ascending by capturedAt. */
export function sortSnapshots(snaps: MetricSnapshot[]): MetricSnapshot[] {
  return [...snaps].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function latestSnapshot(snaps: MetricSnapshot[]): MetricSnapshot | null {
  if (snaps.length === 0) return null;
  return sortSnapshots(snaps)[snaps.length - 1];
}

/** Latest snapshot captured at or before `t`, with a non-null `field`. */
export function snapshotAtOrBefore(
  snaps: MetricSnapshot[],
  t: string,
  field: MetricField = "views",
): MetricSnapshot | null {
  const sorted = sortSnapshots(snaps);
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].capturedAt <= t && sorted[i][field] !== null) return sorted[i];
  }
  return null;
}

export interface Delta {
  value: number;
  /** False when the video has been tracked for less than the window. */
  coversFullWindow: boolean;
  fromTime: string;
  toTime: string;
}

/**
 * Growth of `field` over the trailing window.
 *
 * Baseline = the newest snapshot at/before (now - window), but it must not be
 * older than 2× the window — a "gained in the last 10 minutes" number computed
 * against a 7-hour-old baseline would be a lie. When no valid baseline exists
 * but the video's earliest snapshot falls INSIDE the window (tracking younger
 * than the window), we report growth since tracking began and flag it as
 * partial-window. Otherwise: null ("not enough data"), never a fabrication.
 */
export function deltaOverWindow(
  snaps: MetricSnapshot[],
  windowMs: number,
  field: MetricField = "views",
  now: Date = new Date(),
): Delta | null {
  const usable = sortSnapshots(snaps).filter((s) => s[field] !== null);
  if (usable.length < 2) return null;
  const latest = usable[usable.length - 1];
  const cutoff = new Date(now.getTime() - windowMs).toISOString();
  const staleFloor = new Date(now.getTime() - 2 * windowMs).toISOString();
  let baseline: MetricSnapshot | null = null;
  for (let i = usable.length - 1; i >= 0; i--) {
    if (usable[i].capturedAt <= cutoff) {
      if (usable[i].capturedAt >= staleFloor) baseline = usable[i];
      break;
    }
  }
  let coversFullWindow = true;
  if (!baseline) {
    const earliest = usable[0];
    // Only usable as a partial-window fallback when tracking began within
    // the window itself.
    if (earliest.capturedAt <= cutoff) return null;
    baseline = earliest;
    coversFullWindow = false;
  }
  if (baseline.id === latest.id) return null;
  return {
    value: (latest[field] as number) - (baseline[field] as number),
    coversFullWindow,
    fromTime: baseline.capturedAt,
    toTime: latest.capturedAt,
  };
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface TrendPoint {
  t: string;
  views: number | null;
  engagements: number | null;
  comments: number | null;
}

/**
 * Aggregate trend across videos: for each time bucket, take each video's most
 * recent snapshot at/before the bucket end and sum. Buckets where no video has
 * any data yet yield null (gap in the chart, not a fake zero).
 */
export function aggregateTrend(
  snapshotsByVideo: Map<string, MetricSnapshot[]>,
  from: Date,
  to: Date,
  buckets: number,
): TrendPoint[] {
  const sortedByVideo = new Map<string, MetricSnapshot[]>();
  for (const [vid, snaps] of snapshotsByVideo) {
    sortedByVideo.set(vid, sortSnapshots(snaps));
  }
  const points: TrendPoint[] = [];
  const span = to.getTime() - from.getTime();
  if (span <= 0 || buckets < 1) return points;
  for (let i = 1; i <= buckets; i++) {
    const t = new Date(from.getTime() + (span * i) / buckets).toISOString();
    let views: number | null = null;
    let eng: number | null = null;
    let comments: number | null = null;
    for (const snaps of sortedByVideo.values()) {
      let last: MetricSnapshot | null = null;
      for (const s of snaps) {
        if (s.capturedAt <= t) last = s;
        else break;
      }
      if (!last) continue;
      if (last.views !== null) views = (views ?? 0) + last.views;
      if (last.comments !== null) comments = (comments ?? 0) + last.comments;
      const e = engagements(last);
      if (e !== null) eng = (eng ?? 0) + e;
    }
    points.push({ t, views, engagements: eng, comments });
  }
  return points;
}

/**
 * True when there isn't enough history for a meaningful trend line —
 * fewer than 3 buckets with data, or all values identical (flat line).
 */
export function isSparseTrend(points: TrendPoint[]): boolean {
  const withData = points.filter((p) => p.views !== null);
  if (withData.length < 3) return true;
  const values = new Set(withData.map((p) => p.views));
  return values.size < 2;
}

/** Compact per-video rollup used by leaderboards and tables. */
export interface VideoMetrics {
  video: Video;
  latest: MetricSnapshot | null;
  engagements: number | null;
  engagementRate: number | null;
  delta24h: Delta | null;
  delta1h: Delta | null;
  delta10m: Delta | null;
  growthSinceTracked: number | null;
}

export function computeVideoMetrics(
  video: Video,
  snaps: MetricSnapshot[],
  now: Date = new Date(),
): VideoMetrics {
  const latest = latestSnapshot(snaps);
  const sorted = sortSnapshots(snaps).filter((s) => s.views !== null);
  const first = sorted.length > 0 ? sorted[0] : null;
  return {
    video,
    latest,
    engagements: latest ? engagements(latest) : null,
    engagementRate: latest ? engagementRate(latest) : null,
    delta24h: deltaOverWindow(snaps, DAY_MS, "views", now),
    delta1h: deltaOverWindow(snaps, HOUR_MS, "views", now),
    delta10m: deltaOverWindow(snaps, 10 * 60 * 1000, "views", now),
    growthSinceTracked:
      latest && latest.views !== null && first && first.views !== null && first.id !== latest.id
        ? latest.views - first.views
        : null,
  };
}
