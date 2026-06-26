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
 * Aggregate trend across videos: for each time bucket, carry forward each
 * video's last-known-good value PER FIELD (newest non-null snapshot at/before
 * the bucket) and sum. Buckets where no video has any data yet yield null
 * (gap in the chart, not a fake zero).
 *
 * Per-field carry-forward — not "newest snapshot, then check null" — is what
 * keeps the chart honest:
 *  - Public view counts are monotonic; a lower/stale reading is rejected on
 *    write and stored as views:null (the per-video display keeps the last
 *    confirmed value via lastConfirmed). The aggregate must do the SAME, or a
 *    single rejected reading would erase that video from the bucket and create
 *    an artificial DROP (the Facebook steep-drop bug).
 *  - A video missing from one refresh cycle simply has no new snapshot; its
 *    last-known-good carries forward instead of vanishing.
 *  - Engagement is a 5-component composite (likes+comments+shares+saves+
 *    bookmarks); each component is carried forward INDEPENDENTLY so a cycle that
 *    reports only some components (common on Facebook Reels, where likes/comments
 *    arrive on the detail tier) never drops a previously confirmed component.
 * Net effect: the final bucket equals the sum of each video's last-confirmed
 * value = the platform/KPI total, and partial/missing cycles never dip the line.
 * (The equals-KPI-total invariant assumes manual corrections are pinned — which
 * they always are; see lastConfirmed's manual-TTL rule.)
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
      // Last-known-good per field, independently (comments doubles as both its
      // own series and an engagement component).
      let vLast: number | null = null;
      let cLast: number | null = null;
      let lkLast: number | null = null;
      let shLast: number | null = null;
      let svLast: number | null = null;
      let bkLast: number | null = null;
      for (const s of snaps) {
        if (s.capturedAt > t) break;
        if (s.views !== null) vLast = s.views;
        if (s.comments !== null) cLast = s.comments;
        if (s.likes !== null) lkLast = s.likes;
        if (s.shares !== null) shLast = s.shares;
        if (s.saves !== null) svLast = s.saves;
        if (s.bookmarks !== null) bkLast = s.bookmarks;
      }
      if (vLast !== null) views = (views ?? 0) + vLast;
      if (cLast !== null) comments = (comments ?? 0) + cLast;
      const eLast = sumNullable([lkLast, cLast, shLast, svLast, bkLast]);
      if (eLast !== null) eng = (eng ?? 0) + eLast;
    }
    points.push({ t, views, engagements: eng, comments });
  }
  return points;
}

/** Per-video input for the estimated historical trend. */
export interface EstimatedVideoMeta {
  id: string;
  publishedAt: string | null;
  /** True → fill the pre-first-snapshot gap with a 0→first-value ramp (Bootcamp). */
  estimated: boolean;
}

/** First snapshot (time + value) where a field was actually reported. */
function firstConfirmed(sorted: MetricSnapshot[], pick: (s: MetricSnapshot) => number | null): { t: number; v: number } | null {
  for (const s of sorted) {
    const v = pick(s);
    if (v !== null) return { t: new Date(s.capturedAt).getTime(), v };
  }
  return null;
}

/**
 * DISPLAY-ONLY estimated historical trend. Identical to aggregateTrend EXCEPT,
 * for `estimated` videos (Bootcamp), the gap BEFORE the video's FIRST snapshot
 * (of any field) is filled per-field with a straight 0→first-value ramp anchored
 * at publishedAt (0 before publish; null when a field has no value to ramp to). At
 * and after that first snapshot EVERY field uses the same last-known-good
 * carry-forward as aggregateTrend — so this series is byte-for-byte equal to the
 * real trend for all buckets at/after each video's first snapshot (and equal
 * everywhere once every estimated video has data), and its final bucket equals the
 * KPI total. Non-estimated videos behave exactly like aggregateTrend. This NEVER
 * writes snapshots and is consumed only by the chart; KPIs / platform totals /
 * reports / periodDelta read the real series.
 *
 * Why: Bootcamp back-catalog was imported in one day, so the real line cliffs up
 * on import day. Ramping from each video's publish date shows a plausible history
 * without inventing stored data.
 */
export function aggregateEstimatedTrend(
  meta: EstimatedVideoMeta[],
  snapshotsByVideo: Map<string, MetricSnapshot[]>,
  from: Date,
  to: Date,
  buckets: number,
): TrendPoint[] {
  const points: TrendPoint[] = [];
  const span = to.getTime() - from.getTime();
  if (span <= 0 || buckets < 1) return points;

  // Precompute per video: sorted snaps, publish ms, first-confirmed per field, and
  // the video's FIRST snapshot time (any field). The ramp is gated on that single
  // boundary so EVERY field switches to actual together once the video has real
  // data — guaranteeing this series equals aggregateTrend for all buckets at/after
  // it (a lagging field never keeps ramping past the first snapshot).
  const prepared = meta.map((m) => {
    const sorted = sortSnapshots(snapshotsByVideo.get(m.id) ?? []);
    const pub = m.publishedAt ? new Date(m.publishedAt).getTime() : null;
    return {
      estimated: m.estimated && pub !== null, // can only ramp with a publish anchor
      pub,
      sorted,
      firstSnapMs: sorted.length ? new Date(sorted[0].capturedAt).getTime() : null,
      firstViews: firstConfirmed(sorted, (s) => s.views),
      firstComments: firstConfirmed(sorted, (s) => s.comments),
      firstEng: firstConfirmed(sorted, (s) => sumNullable([s.likes, s.comments, s.shares, s.saves, s.bookmarks])),
    };
  });

  // Ramp value at time t: 0 before publish, linear to first.v by first.t, anchored
  // at pub. Returns null when the field has no confirmed value to ramp toward, so a
  // dataless estimated video contributes nothing (matches aggregateTrend — no fake
  // 0-floor). Only ever used in the pre-first-snapshot gap, so it never overrides a
  // real reading.
  const ramp = (tMs: number, pub: number, first: { t: number; v: number } | null): number | null => {
    if (!first) return null; // no data to estimate toward → contribute nothing
    if (tMs <= pub) return 0;
    if (first.t <= pub) return first.v;
    const frac = (tMs - pub) / (first.t - pub);
    return first.v * (frac < 0 ? 0 : frac > 1 ? 1 : frac);
  };

  for (let i = 1; i <= buckets; i++) {
    const tIso = new Date(from.getTime() + (span * i) / buckets).toISOString();
    const tMs = new Date(tIso).getTime();
    let views: number | null = null;
    let eng: number | null = null;
    let comments: number | null = null;
    for (const p of prepared) {
      // Real last-known-good per field up to t (same logic as aggregateTrend).
      let vLast: number | null = null;
      let cLast: number | null = null;
      let lkLast: number | null = null;
      let shLast: number | null = null;
      let svLast: number | null = null;
      let bkLast: number | null = null;
      for (const s of p.sorted) {
        if (s.capturedAt > tIso) break;
        if (s.views !== null) vLast = s.views;
        if (s.comments !== null) cLast = s.comments;
        if (s.likes !== null) lkLast = s.likes;
        if (s.shares !== null) shLast = s.shares;
        if (s.saves !== null) svLast = s.saves;
        if (s.bookmarks !== null) bkLast = s.bookmarks;
      }
      const engLast = sumNullable([lkLast, cLast, shLast, svLast, bkLast]);

      // Ramp ONLY before the video's first snapshot (any field). At/after it, every
      // field uses the real last-known-good (possibly null) — identical to
      // aggregateTrend — so no field keeps ramping past the first real reading.
      const beforeFirstSnap = p.estimated && (p.firstSnapMs === null || tMs < p.firstSnapMs);
      const vC = vLast !== null ? vLast : beforeFirstSnap ? ramp(tMs, p.pub as number, p.firstViews) : null;
      const cC = cLast !== null ? cLast : beforeFirstSnap ? ramp(tMs, p.pub as number, p.firstComments) : null;
      const eC = engLast !== null ? engLast : beforeFirstSnap ? ramp(tMs, p.pub as number, p.firstEng) : null;

      if (vC !== null) views = (views ?? 0) + vC;
      if (cC !== null) comments = (comments ?? 0) + cC;
      if (eC !== null) eng = (eng ?? 0) + eC;
    }
    points.push({ t: tIso, views, engagements: eng, comments });
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

/**
 * Last-confirmed value for one metric: the newest snapshot where the source
 * actually reported it. `stale` means a newer snapshot exists without it —
 * display as "N · last confirmed X ago", never as a fresh reading.
 */
export interface ConfirmedValue {
  value: number;
  at: string;
  stale: boolean;
  /** True when the value came from an admin manual verification snapshot. */
  manual: boolean;
}

export type ConfirmedMetrics = Record<
  "views" | "likes" | "comments" | "shares",
  ConfirmedValue | null
>;

/** Compact per-video rollup used by leaderboards and tables. */
export interface VideoMetrics {
  video: Video;
  latest: MetricSnapshot | null;
  /** Last-confirmed values per metric (survives a missing-this-refresh gap). */
  confirmed: ConfirmedMetrics;
  engagements: number | null;
  engagementRate: number | null;
  delta24h: Delta | null;
  delta1h: Delta | null;
  delta10m: Delta | null;
  growthSinceTracked: number | null;
}

function isManualSnapshot(s: MetricSnapshot): boolean {
  return Boolean(s.rawJson && typeof s.rawJson === "object" && (s.rawJson as { manual?: boolean }).manual);
}
/**
 * Pinned manual snapshots are deliberate admin CORRECTIONS (e.g. a Facebook
 * Reel's real public play count, which the actor undercounts). Unlike a
 * 24h spot-check, a correction must persist — it should not silently revert to
 * the known-wrong automated value after a day. Monotonic protection still lets
 * automated tracking resume once it genuinely exceeds the corrected value.
 */
function isPinnedSnapshot(s: MetricSnapshot): boolean {
  return Boolean(s.rawJson && typeof s.rawJson === "object" && (s.rawJson as { pinned?: boolean }).pinned);
}

const MANUAL_OVERRIDE_TTL_MS = 24 * HOUR_MS;

function lastConfirmed(
  sorted: MetricSnapshot[],
  field: "views" | "likes" | "comments" | "shares",
  now: Date,
): ConfirmedValue | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const v = sorted[i][field];
    if (v === null) continue;
    const manual = isManualSnapshot(sorted[i]);
    // Non-pinned manual verifications expire after 24h — fall through to the
    // newest automated value rather than displaying a day-old spot-check.
    // Pinned corrections never expire (admin asserts ground truth).
    if (
      manual &&
      !isPinnedSnapshot(sorted[i]) &&
      now.getTime() - new Date(sorted[i].capturedAt).getTime() > MANUAL_OVERRIDE_TTL_MS
    ) {
      continue;
    }
    return { value: v, at: sorted[i].capturedAt, stale: i < sorted.length - 1, manual };
  }
  return null;
}

export function computeVideoMetrics(
  video: Video,
  snaps: MetricSnapshot[],
  now: Date = new Date(),
): VideoMetrics {
  const latest = latestSnapshot(snaps);
  const allSorted = sortSnapshots(snaps);
  const sorted = allSorted.filter((s) => s.views !== null);
  const first = sorted.length > 0 ? sorted[0] : null;
  return {
    video,
    latest,
    confirmed: {
      views: lastConfirmed(allSorted, "views", now),
      likes: lastConfirmed(allSorted, "likes", now),
      comments: lastConfirmed(allSorted, "comments", now),
      shares: lastConfirmed(allSorted, "shares", now),
    },
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

/**
 * Ranking by views for leaderboards: only videos with a confirmed (current or
 * last-confirmed) view count compete; never-confirmed videos are excluded
 * rather than ranked at 0.
 */
export function rankByConfirmedViews(list: VideoMetrics[]): VideoMetrics[] {
  return list
    .filter((m) => m.confirmed.views !== null)
    .sort((a, b) => (b.confirmed.views?.value ?? 0) - (a.confirmed.views?.value ?? 0));
}

/**
 * Frozen-views detection: a fast-moving public video whose view count hasn't
 * changed across the last few refreshes suggests the SOURCE is serving
 * delayed data — confidence should drop to partial even though refreshes
 * "succeed". True when ≥3 snapshots exist, the non-null views among the last
 * 3 are all identical, and they span at least ~12 minutes.
 */
export function isViewsFrozen(snaps: MetricSnapshot[], now: Date = new Date()): boolean {
  const sorted = sortSnapshots(snaps);
  if (sorted.length < 3) return false;
  const last3 = sorted.slice(-3);
  const values = [...new Set(last3.map((s) => s.views).filter((v): v is number => v !== null))];
  if (values.length !== 1) return false;
  const spanMs = new Date(last3[2].capturedAt).getTime() - new Date(last3[0].capturedAt).getTime();
  if (spanMs < 12 * 60 * 1000) return false;
  // Only meaningful if the latest reading isn't ancient anyway
  return now.getTime() - new Date(last3[2].capturedAt).getTime() < 2 * HOUR_MS;
}

/**
 * Monotonic-views rule: public view counts don't decrease. A reading lower
 * than the last confirmed value is stale/cached source output — record null
 * (the display layer keeps the last confirmed value) and surface the
 * rejected reading for logging.
 */
export function applyMonotonicViews(
  newViews: number | null,
  prevConfirmedViews: number | null,
): { views: number | null; rejectedLower: number | null } {
  if (newViews !== null && prevConfirmedViews !== null && newViews < prevConfirmedViews) {
    return { views: null, rejectedLower: newViews };
  }
  return { views: newViews, rejectedLower: null };
}
