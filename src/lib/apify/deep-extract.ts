// Deep recursive metric extraction — the last line of defense when an actor's
// output shape isn't covered by the explicit path lists in normalize.ts.
// Walks nested objects looking for known metric field names, preferring exact
// known names over fuzzy matches, and reports the path it found for debugging.

type Raw = Record<string, unknown>;

export type MetricKind = "views" | "likes" | "comments" | "shares";

/** Exact field names (case-insensitive), strongest signal first. */
const EXACT_NAMES: Record<MetricKind, string[]> = {
  views: [
    "video_view_count", "videoviewcount", "viewscount", "viewcount", "views",
    "playcount", "play_count", "plays", "totalvideoviews", "postviews",
    "reelviews", "watchcount", "watch_count", "view_count", "videoplaycount",
  ],
  likes: [
    "likescount", "likecount", "like_count", "likes", "diggcount",
    "reaction_count", "reactionscount", "unified_reactors", "numberoflikes",
  ],
  comments: [
    "total_comment_count", "commentscount", "commentcount", "comment_count",
    "comments_count", "numberofcomments",
  ],
  shares: [
    "sharecount", "sharescount", "share_count", "shares",
    "share_count_reduced", "resharescount", "numberofshares",
  ],
};

/** Fuzzy substring fallbacks, only consulted when no exact name matched. */
const FUZZY_PATTERNS: Record<MetricKind, RegExp> = {
  views: /view|play|watch/i,
  likes: /like|digg|reaction/i,
  comments: /comment/i,
  shares: /share/i,
};

/** Field names that look metric-ish but never are. */
const EXCLUDED = /duration|loop|width|height|index|offset|id$|_id|timestamp|time|date|live|viewer_|viewport|preview|autoplay|playable|player|playback/i;

function toMetricNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
}

export interface DeepMetricHit {
  value: number;
  /** Dot path into the raw object, e.g. "feedback.video_view_count". */
  path: string;
  exact: boolean;
}

/**
 * Find the most plausible value for a metric anywhere in a raw actor item.
 * Exact known field names win over fuzzy matches; shallower paths win over
 * deeper ones. Returns null when nothing trustworthy is found.
 */
export function deepFindMetric(raw: Raw, kind: MetricKind, maxDepth = 8): DeepMetricHit | null {
  const exactNames = new Set(EXACT_NAMES[kind]);
  const fuzzy = FUZZY_PATTERNS[kind];
  let bestExact: DeepMetricHit | null = null;
  let bestFuzzy: DeepMetricHit | null = null;
  let bestExactDepth = Infinity;
  let bestFuzzyDepth = Infinity;

  const visit = (obj: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || obj === null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      // Only peek at the first few entries — metric fields don't hide in
      // long arrays, and this bounds the walk.
      obj.slice(0, 3).forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, value] of Object.entries(obj as Raw)) {
      const p = path ? `${path}.${key}` : key;
      if (value !== null && typeof value === "object") {
        // "count-shaped" wrappers: { likers: { count: 44 } }
        const countLike = (value as Raw).count;
        const n = toMetricNumber(countLike);
        if (n !== null && !EXCLUDED.test(key)) {
          const lk = key.toLowerCase();
          if (exactNames.has(lk) || exactNames.has(`${lk}.count`)) {
            if (depth < bestExactDepth) {
              bestExact = { value: n, path: `${p}.count`, exact: true };
              bestExactDepth = depth;
            }
          } else if (fuzzy.test(key) && depth + 1 < bestFuzzyDepth) {
            bestFuzzy = { value: n, path: `${p}.count`, exact: false };
            bestFuzzyDepth = depth + 1;
          }
        }
        visit(value, p, depth + 1);
        continue;
      }
      if (EXCLUDED.test(key)) continue;
      const n = toMetricNumber(value);
      if (n === null) continue;
      const lk = key.toLowerCase();
      if (exactNames.has(lk)) {
        if (depth < bestExactDepth) {
          bestExact = { value: n, path: p, exact: true };
          bestExactDepth = depth;
        }
      } else if (fuzzy.test(key) && /count|total|num/i.test(key)) {
        if (depth < bestFuzzyDepth) {
          bestFuzzy = { value: n, path: p, exact: false };
          bestFuzzyDepth = depth;
        }
      }
    }
  };

  visit(raw, "", 0);
  return bestExact ?? bestFuzzy;
}

/** All four metrics at once, with extraction paths for attempt logging. */
export function deepExtractMetrics(raw: Raw): Partial<
  Record<MetricKind, DeepMetricHit>
> {
  const out: Partial<Record<MetricKind, DeepMetricHit>> = {};
  for (const kind of ["views", "likes", "comments", "shares"] as MetricKind[]) {
    const hit = deepFindMetric(raw, kind);
    if (hit) out[kind] = hit;
  }
  return out;
}
