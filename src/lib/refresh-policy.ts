// Cost-control refresh policy. The external scheduler (cron-job.org) pings
// every 30 minutes; THIS module decides what actually runs:
//   - quiet hours (00:00–06:00 America/New_York, DST-safe): nothing runs
//   - full refresh: every REFRESH_FULL_INTERVAL_MINUTES (default 60)
//   - discovery sweep: included only every REFRESH_DISCOVERY_INTERVAL_MINUTES
//   - comment capture: included only every REFRESH_COMMENTS_INTERVAL_MINUTES
//   - light refresh (hot videos only): optional, between fulls — default OFF
//   - hard budget cap: scheduled runs stop when today's estimated Apify
//     spend reaches APIFY_DAILY_HARD_CAP_USD
// Manual admin refreshes (manual/force/script) bypass the POLICY, never the
// lock — and the admin UI warns about cost. Public users can never refresh.
//
// Pure functions + env-read config; unit tested.

import type { RefreshRun, Video } from "./types";

export interface RefreshPolicyConfig {
  fullIntervalMin: number;
  lightIntervalMin: number;
  discoveryIntervalMin: number;
  commentsIntervalMin: number;
  enableLight: boolean;
  enableDiscovery: boolean;
  enableComments: boolean;
  budgetTargetUsd: number;
  hardCapUsd: number;
  estCostPerRunUsd: number;
  quietHoursEnabled: boolean;
  quietTimezone: string;
  /** Local hour the quiet window starts (inclusive), 0–23. */
  quietStartHour: number;
  /** Local hour the quiet window ends (exclusive), 0–23. */
  quietEndHour: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
function envFloat(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}
function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}
function envHour(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : fallback;
}

export function getRefreshPolicyConfig(): RefreshPolicyConfig {
  return {
    fullIntervalMin: envInt("REFRESH_FULL_INTERVAL_MINUTES", 60),
    lightIntervalMin: envInt("REFRESH_LIGHT_INTERVAL_MINUTES", 30),
    discoveryIntervalMin: envInt("REFRESH_DISCOVERY_INTERVAL_MINUTES", 180),
    commentsIntervalMin: envInt("REFRESH_COMMENTS_INTERVAL_MINUTES", 120),
    // Light refresh defaults OFF: hourly fulls alone hit the $1–2/day target.
    enableLight: envBool("ENABLE_LIGHT_REFRESH", false),
    enableDiscovery: envBool("ENABLE_DISCOVERY_REFRESH", true),
    enableComments: envBool("ENABLE_COMMENT_REFRESH", true),
    budgetTargetUsd: envFloat("APIFY_DAILY_BUDGET_TARGET_USD", 2),
    hardCapUsd: envFloat("APIFY_DAILY_HARD_CAP_USD", 3),
    // ~$20 observed across ~1,150 actor runs ≈ 1.7¢/run; 2¢ is conservative.
    estCostPerRunUsd: envFloat("APIFY_EST_COST_PER_RUN_USD", 0.02),
    quietHoursEnabled: envBool("REFRESH_QUIET_HOURS_ENABLED", true),
    quietTimezone: process.env.REFRESH_QUIET_HOURS_TIMEZONE || "America/New_York",
    quietStartHour: envHour("REFRESH_QUIET_HOURS_START", 0),
    quietEndHour: envHour("REFRESH_QUIET_HOURS_END", 6),
  };
}

/** Local hour-of-day in the configured timezone — DST-safe via Intl. */
export function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  return Number(h);
}

/** Local YYYY-MM-DD in the configured timezone (budget day boundary). */
export function localDateKey(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function isQuietHours(now: Date, cfg: RefreshPolicyConfig): boolean {
  if (!cfg.quietHoursEnabled) return false;
  const h = localHour(now, cfg.quietTimezone);
  return cfg.quietStartHour <= cfg.quietEndHour
    ? h >= cfg.quietStartHour && h < cfg.quietEndHour
    : h >= cfg.quietStartHour || h < cfg.quietEndHour; // window crossing midnight
}

// ── Run-mode bookkeeping (schema-free: encoded in RefreshRun.rawLog[0]) ────

export interface RunMode {
  light: boolean;
  discovery: boolean;
  comments: boolean;
}

export function encodeRunMode(m: RunMode): string {
  return `mode:${m.light ? "light" : "full"} discovery:${m.discovery ? "on" : "off"} comments:${m.comments ? "on" : "off"}`;
}

export function decodeRunMode(run: Pick<RefreshRun, "rawLog">): RunMode | null {
  const first = run.rawLog?.[0];
  if (!first || !first.startsWith("mode:")) return null;
  return {
    light: first.includes("mode:light"),
    discovery: first.includes("discovery:on"),
    comments: first.includes("comments:on"),
  };
}

function minutesSince(iso: string | null, now: Date): number {
  return iso === null ? Infinity : (now.getTime() - new Date(iso).getTime()) / 60_000;
}

function lastSuccessfulWhere(
  runs: RefreshRun[],
  pred: (mode: RunMode) => boolean,
): string | null {
  for (const r of runs) {
    if (r.status !== "success" && r.status !== "partial") continue;
    const mode = decodeRunMode(r);
    if (!mode) {
      // Pre-policy runs (no marker) were always full refreshes with
      // discovery + comments — count them so deploys don't double-run.
      if (pred({ light: false, discovery: true, comments: true })) return r.startedAt;
      continue;
    }
    if (pred(mode)) return r.startedAt;
  }
  return null;
}

export type ScheduledDecision =
  | {
      action: "run";
      mode: RunMode;
      reason: string;
    }
  | { action: "skip"; kind: "quiet" | "budget" | "not_due"; reason: string };

/**
 * Decide what a SCHEDULED (cron) ping is allowed to do right now.
 * `todaysActorRuns` = collection attempts recorded today (local budget day).
 */
export function decideScheduledRefresh(args: {
  now?: Date;
  recentRuns: RefreshRun[];
  todaysActorRuns: number;
  cfg?: RefreshPolicyConfig;
}): ScheduledDecision {
  const now = args.now ?? new Date();
  const cfg = args.cfg ?? getRefreshPolicyConfig();

  if (isQuietHours(now, cfg)) {
    return {
      action: "skip",
      kind: "quiet",
      reason: `Skipped: quiet hours (${String(cfg.quietStartHour).padStart(2, "0")}:00–${String(cfg.quietEndHour).padStart(2, "0")}:00 ${cfg.quietTimezone})`,
    };
  }

  const estSpend = args.todaysActorRuns * cfg.estCostPerRunUsd;
  if (estSpend >= cfg.hardCapUsd) {
    return {
      action: "skip",
      kind: "budget",
      reason: `Skipped: estimated Apify spend today ($${estSpend.toFixed(2)}) reached the daily hard cap ($${cfg.hardCapUsd.toFixed(2)})`,
    };
  }

  const lastFullAt = lastSuccessfulWhere(args.recentRuns, (m) => !m.light);
  const lastAnyAt = lastSuccessfulWhere(args.recentRuns, () => true);
  const lastDiscoveryAt = lastSuccessfulWhere(args.recentRuns, (m) => m.discovery);
  const lastCommentsAt = lastSuccessfulWhere(args.recentRuns, (m) => m.comments);

  if (minutesSince(lastFullAt, now) >= cfg.fullIntervalMin) {
    const discovery =
      cfg.enableDiscovery && minutesSince(lastDiscoveryAt, now) >= cfg.discoveryIntervalMin;
    const comments =
      cfg.enableComments && minutesSince(lastCommentsAt, now) >= cfg.commentsIntervalMin;
    return {
      action: "run",
      mode: { light: false, discovery, comments },
      reason: `full refresh due (last ${lastFullAt ? Math.round(minutesSince(lastFullAt, now)) + "m ago" : "never"})${discovery ? " + discovery" : ""}${comments ? " + comments" : ""}`,
    };
  }

  if (cfg.enableLight && minutesSince(lastAnyAt, now) >= cfg.lightIntervalMin) {
    return {
      action: "run",
      mode: { light: true, discovery: false, comments: false },
      reason: "light refresh due (hot videos only)",
    };
  }

  const nextFullMin = Math.max(1, Math.ceil(cfg.fullIntervalMin - minutesSince(lastFullAt, now)));
  return {
    action: "skip",
    kind: "not_due",
    reason: `Skipped: full refresh not due yet (next in ~${nextFullMin}m)`,
  };
}

// ── Hot / warm / cold video classification (light-refresh targeting) ──────

export type VideoHeat = "hot" | "warm" | "cold";

export function classifyVideoHeat(args: {
  video: Pick<Video, "publishedAt" | "firstTrackedAt">;
  /** Latest confirmed views (for top-N ranking, computed by the caller). */
  isTopRanked: boolean;
  gained24h: number | null;
  now?: Date;
}): VideoHeat {
  const now = args.now ?? new Date();
  const postedAt = args.video.publishedAt ?? args.video.firstTrackedAt;
  const ageHours = (now.getTime() - new Date(postedAt).getTime()) / 3_600_000;
  if (args.isTopRanked || ageHours <= 24 || (args.gained24h ?? 0) > 500) return "hot";
  if (ageHours <= 7 * 24 || (args.gained24h ?? 0) > 0) return "warm";
  return "cold";
}

/** Estimated spend summary for the admin cost panel. */
export function summarizeBudget(args: {
  todaysActorRuns: number;
  now?: Date;
  cfg?: RefreshPolicyConfig;
}): {
  runsToday: number;
  estSpendUsd: number;
  projectedDayUsd: number;
  targetUsd: number;
  hardCapUsd: number;
  overTarget: boolean;
  capReached: boolean;
} {
  const cfg = args.cfg ?? getRefreshPolicyConfig();
  const now = args.now ?? new Date();
  const estSpendUsd = args.todaysActorRuns * cfg.estCostPerRunUsd;
  // Project across the ACTIVE day (quiet hours don't spend).
  const h = localHour(now, cfg.quietTimezone);
  const activeHoursSoFar = Math.max(0.5, h - cfg.quietEndHour);
  const activeHoursTotal = 24 - (cfg.quietEndHour - cfg.quietStartHour > 0 ? cfg.quietEndHour - cfg.quietStartHour : 6);
  const projectedDayUsd =
    h < cfg.quietEndHour ? estSpendUsd : (estSpendUsd / activeHoursSoFar) * activeHoursTotal;
  return {
    runsToday: args.todaysActorRuns,
    estSpendUsd,
    projectedDayUsd,
    targetUsd: cfg.budgetTargetUsd,
    hardCapUsd: cfg.hardCapUsd,
    overTarget: projectedDayUsd > cfg.budgetTargetUsd,
    capReached: estSpendUsd >= cfg.hardCapUsd,
  };
}
