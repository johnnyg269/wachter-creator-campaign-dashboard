// Range/coverage helpers for the Campaign Momentum chart. Pure functions —
// unit tested. The chart window is clamped to real snapshot history (no dead
// space, no invented data); these helpers make that clamping HONEST by
// telling the viewer exactly how much history exists.

import type { MetricSnapshot } from "./types";
import type { Video } from "./types";

export type ChartRange = "24h" | "7d" | "30d" | "all";

export const RANGE_MS: Record<Exclude<ChartRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric" });
}

function shortDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function humanDuration(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1.5) return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * One honest line about how much history backs the selected range.
 *  - null when the selected range is fully covered by real history (nothing
 *    to explain), or when there's no history at all (empty state handles it)
 *  - "Showing all available history · since Jun 11" for All
 *  - "30d selected · 15 hours of history available (since Jun 11, 12:36 PM)"
 *    when the range asks for more than exists
 */
export function coverageNote(
  range: ChartRange,
  historyStartIso: string | null,
  now: Date = new Date(),
): string | null {
  if (!historyStartIso) return null;
  const availableMs = now.getTime() - new Date(historyStartIso).getTime();
  if (availableMs <= 0) return null;
  if (range === "all") {
    return `Showing all available history · since ${shortDateTime(historyStartIso)}`;
  }
  const requested = RANGE_MS[range];
  // 5% slack: a 23.9-hour history fully covers a "24h" selection in spirit.
  if (availableMs >= requested * 0.95) return null;
  return `${range} selected · ${humanDuration(availableMs)} of history available (since ${shortDateTime(historyStartIso)})`;
}

/** Empty/sparse-state explainer: when did tracking actually begin. */
export function historyBeganNote(historyStartIso: string | null): string {
  return historyStartIso
    ? `Historical tracking began ${shortDate(historyStartIso)}. More history will appear as scheduled refreshes run every 5 minutes.`
    : "History will appear as scheduled refreshes run every 5 minutes.";
}

/**
 * Fastest-growing video WITHIN a window: gain = last confirmed views minus
 * first confirmed views captured inside [from, now]. Real readings only —
 * videos without two confirmed readings in the window don't qualify.
 */
export function fastestGrowingInWindow(
  videos: Video[],
  snapshotsByVideo: Map<string, MetricSnapshot[]>,
  from: Date,
): { video: Video; gained: number } | null {
  let best: { video: Video; gained: number } | null = null;
  const fromIso = from.toISOString();
  for (const video of videos) {
    if (video.hidden) continue;
    const confirmed = (snapshotsByVideo.get(video.id) ?? [])
      .filter((s) => s.capturedAt >= fromIso && s.views !== null)
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    if (confirmed.length < 2) continue;
    const gained = (confirmed[confirmed.length - 1].views as number) - (confirmed[0].views as number);
    if (gained > 0 && (!best || gained > best.gained)) best = { video, gained };
  }
  return best;
}
