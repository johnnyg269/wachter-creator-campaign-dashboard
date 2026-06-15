// Facebook-aware view resolver — the views counterpart to resolveThumb.
//
// Why this exists: the Facebook posts scraper exposes a reel's view metric as
// `viewsCount`, which is a STRICTER count than the "plays" number Facebook
// shows publicly on the Reel card (observed ~0.44× of the public value). It
// exposes no plays/play_count field and no formatted display string. This
// resolver (a) prefers a true public play/view count if any actor version ever
// returns one, (b) safely parses formatted display strings like "124K"/"1.2M"
// if present, (c) falls back to the real `viewsCount` as a labelled proxy, and
// (d) rejects unrelated counts (reactions, likes, comments, shares, followers,
// duration, live-viewer, loop). It reports the path + confidence + raw display
// value for admin diagnostics. It NEVER invents a number.

import type { Platform } from "../types";
import { deepFindMetric } from "./deep-extract";

type Raw = Record<string, unknown>;

export type ViewConfidence = "exact" | "display_string" | "proxy" | "deep" | "none";

export interface ViewResolution {
  /** Resolved numeric view/play count, or null when nothing trustworthy found. */
  value: number | null;
  /** Dot-path the value came from (admin diagnostics). */
  extractionPath: string | null;
  confidence: ViewConfidence;
  /** "feed" (carries viewsCount) vs "reel_page" (no count) vs unknown. */
  sourceSurface: "feed" | "reel_page" | "unknown";
  /** The original formatted string when the value was parsed from one ("124K"). */
  rawDisplayValue: string | null;
}

function pick(obj: Raw, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Raw)[key];
  }
  return cur;
}

/**
 * Parse a human display count safely: "124K" → 124000, "1.2M" → 1200000,
 * "1,234,567" → 1234567, "987" → 987. Returns null for anything that isn't
 * unambiguously a count (e.g. "2:14", "HD", "", "1.2.3").
 */
export function parseDisplayCount(input: string): number | null {
  const s = input.trim().replace(/\s*(views?|plays?|watch(?:ed)?)\s*$/i, "").trim();
  if (s === "") return null;
  const m = s.match(/^([\d]{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([KMB])?$/i);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base) || base < 0) return null;
  const mult = m[2] ? { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[m[2].toLowerCase()] ?? 1 : 1;
  const n = Math.round(base * mult);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function numAt(obj: Raw, path: string): number | null {
  const v = pick(obj, path);
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v === "string" && /^\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
}

// True public play/view counts — highest confidence (if any actor exposes them).
const PLAY_PATHS = [
  "videoPlayCount", "video_play_count", "playCount", "play_count", "plays",
  "reelPlayCount", "reel_play_count", "totalVideoViews", "total_video_views",
  "videoViewCount", "video_view_count", "watchCount", "watch_count",
  "short_form_video_context.playback_video.play_count",
  "short_form_video_context.playback_video.video_view_count",
  "media.0.play_count", "media.0.video_view_count", "feedback.video_view_count",
];
// Formatted display strings that unambiguously mean plays/views.
const DISPLAY_PATHS = [
  "playCountFormatted", "play_count_formatted", "viewsCountFormatted",
  "video_view_count_string", "post_view_count_string", "viewCountText",
  "play_count_reduced", "videoViewCountText",
];
// The real-but-stricter view metric this FB actor returns (labelled proxy).
const PROXY_PATHS = ["viewsCount", "views", "viewCount", "stats.playCount"];

/** Generic (non-FB) priority — preserves the existing normalizer behavior. */
const GENERIC_PATHS = [
  "videoPlayCount", "playCount", "plays", "clips_play_count", "play_count",
  "views", "viewCount", "videoViewCount", "stats.playCount", "viewsCount",
  "video_view_count", "shortViewCount",
];

function firstAt(obj: Raw, paths: string[]): { value: number; path: string } | null {
  for (const p of paths) {
    const n = numAt(obj, p);
    if (n !== null) return { value: n, path: p };
  }
  return null;
}

function firstDisplay(obj: Raw, paths: string[]): { value: number; path: string; raw: string } | null {
  for (const p of paths) {
    const v = pick(obj, p);
    if (typeof v === "string") {
      const n = parseDisplayCount(v);
      if (n !== null) return { value: n, path: p, raw: v.trim() };
    }
  }
  return null;
}

function surfaceOf(obj: Raw): "feed" | "reel_page" | "unknown" {
  // The feed surface carries viewsCount + a media[] array with a videoId; the
  // reel-page surface returns the post without these.
  if ("viewsCount" in obj || Array.isArray((obj as Raw).media)) return "feed";
  if ("short_form_video_context" in obj) return "reel_page";
  return "unknown";
}

/**
 * Resolve the best view/play count for a normalized item. Facebook gets the
 * play-first priority + display-string parsing + proxy fallback; other
 * platforms keep the generic priority (then a deep fallback).
 */
export function resolveViews(obj: Raw, platform: Platform): ViewResolution {
  if (platform === "facebook") {
    const play = firstAt(obj, PLAY_PATHS);
    if (play) {
      return { value: play.value, extractionPath: play.path, confidence: "exact", sourceSurface: surfaceOf(obj), rawDisplayValue: null };
    }
    const disp = firstDisplay(obj, DISPLAY_PATHS);
    if (disp) {
      return { value: disp.value, extractionPath: disp.path, confidence: "display_string", sourceSurface: surfaceOf(obj), rawDisplayValue: disp.raw };
    }
    const proxy = firstAt(obj, PROXY_PATHS);
    if (proxy) {
      return { value: proxy.value, extractionPath: proxy.path, confidence: "proxy", sourceSurface: surfaceOf(obj), rawDisplayValue: null };
    }
    const deep = deepFindMetric(obj, "views");
    if (deep) {
      return { value: deep.value, extractionPath: deep.path, confidence: "deep", sourceSurface: surfaceOf(obj), rawDisplayValue: null };
    }
    return { value: null, extractionPath: null, confidence: "none", sourceSurface: surfaceOf(obj), rawDisplayValue: null };
  }

  // Non-Facebook: generic priority, then deep fallback (unchanged behavior).
  const generic = firstAt(obj, GENERIC_PATHS);
  if (generic) {
    return { value: generic.value, extractionPath: generic.path, confidence: "exact", sourceSurface: "unknown", rawDisplayValue: null };
  }
  const deep = deepFindMetric(obj, "views");
  if (deep) {
    return { value: deep.value, extractionPath: deep.path, confidence: "deep", sourceSurface: "unknown", rawDisplayValue: null };
  }
  return { value: null, extractionPath: null, confidence: "none", sourceSurface: "unknown", rawDisplayValue: null };
}
