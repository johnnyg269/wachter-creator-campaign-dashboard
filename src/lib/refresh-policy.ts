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
import { getSocialcrawlDailyCreditCap, isSocialcrawlEnabled } from "./config";

export interface RefreshPolicyConfig {
  fullIntervalMin: number;
  lightIntervalMin: number;
  discoveryIntervalMin: number;
  /** How far back (hours) a discovery run auto-adds new campaign posts; older
   *  eligible posts go to the admin review queue. */
  discoveryLookbackHours: number;
  commentsIntervalMin: number;
  /** Full comment-detail (text) pull cadence — kept for the admin display. */
  commentDetailIntervalHours: number;
  /** First comment-detail window hour (back-compat / admin display). */
  commentDetailHour: number;
  /** Local hours (0–23) the comment-detail pull is allowed at/after — one pull
   * per window per day (e.g. [12, 18] = twice per active day). */
  commentDetailWindows: number[];
  /** Timezone for the comment-detail day boundary + target hour. */
  commentDetailTimezone: string;
  enableLight: boolean;
  enableDiscovery: boolean;
  enableComments: boolean;
  budgetTargetUsd: number;
  hardCapUsd: number;
  estCostPerRunUsd: number;
  /** SocialCrawl primary mode (changes cadence default + budget basis). */
  socialcrawlEnabled: boolean;
  /** Daily SocialCrawl credit cap — scheduled refreshes stop when reached. */
  socialcrawlDailyCreditCap: number;
  /** Daily SocialCrawl credits METRICS may consume (sweeps + per-post lane). The
   * rest of the cap is reserved for comments (≥75), discovery (≥25), and
   * emergency headroom (≥25) so heavy metrics days can never starve them.
   * 350-cap default split: 225 metrics / 75 comments / 25 discovery / 25 spare. */
  metricsDailyBudget: number;
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
  // SocialCrawl primary: metrics are cheap (3 credits/refresh) so the approved
  // cadence is every 15 min during active hours. On Apify (fallback/legacy) the
  // default stays 60 min to protect Apify cost. Comment detail runs twice per
  // active day (12:00 + 18:00 ET). YouTube stays free via the Data API.
  const scOn = isSocialcrawlEnabled();
  const commentDetailIntervalHours = envInt("COMMENT_DETAIL_REFRESH_INTERVAL_HOURS", 24);
  const pullsPerDay = envInt("COMMENT_DETAIL_PULLS_PER_DAY", 2);
  const w1 = envHour("COMMENT_DETAIL_PULL_1_ET", envHour("COMMENT_DETAIL_REFRESH_HOUR", 12));
  const w2 = envHour("COMMENT_DETAIL_PULL_2_ET", 18);
  const commentDetailWindows = (pullsPerDay >= 2 ? [w1, w2] : [w1])
    .filter((h, i, a) => a.indexOf(h) === i)
    .sort((a, b) => a - b);
  return {
    // METRICS_REFRESH_INTERVAL_MINUTES (new) > REFRESH_FULL_INTERVAL_MINUTES
    // (legacy) > default (15 on SocialCrawl, 60 on Apify).
    // Scaled back (July credit-contention): SocialCrawl sweeps now run at most
    // every 30 min — the old 15-min cadence, with 264 tracked videos, consumed
    // the whole daily cap by mid-morning and starved comments + discovery. The
    // floor applies only in the SocialCrawl regime; env can still slow it further.
    fullIntervalMin: Math.max(
      scOn ? 30 : 1,
      envInt("METRICS_REFRESH_INTERVAL_MINUTES", envInt("REFRESH_FULL_INTERVAL_MINUTES", scOn ? 30 : 60)),
    ),
    lightIntervalMin: envInt("REFRESH_LIGHT_INTERVAL_MINUTES", 30),
    // Discovery (finding NEW campaign posts) runs every DISCOVERY_REFRESH_INTERVAL_HOURS
    // active hours — default 2h during launch so last-night/today posts appear
    // quickly. Legacy REFRESH_DISCOVERY_INTERVAL_MINUTES still overrides if set.
    discoveryIntervalMin: envInt(
      "REFRESH_DISCOVERY_INTERVAL_MINUTES",
      envInt("DISCOVERY_REFRESH_INTERVAL_HOURS", 2) * 60,
    ),
    discoveryLookbackHours: envInt("DISCOVERY_LOOKBACK_HOURS", 72),
    commentsIntervalMin: envInt("REFRESH_COMMENTS_INTERVAL_MINUTES", commentDetailIntervalHours * 60),
    commentDetailIntervalHours,
    commentDetailHour: commentDetailWindows[0] ?? 12,
    commentDetailWindows,
    commentDetailTimezone:
      process.env.COMMENT_DETAIL_REFRESH_TIMEZONE ||
      process.env.REFRESH_QUIET_HOURS_TIMEZONE ||
      "America/New_York",
    // On SocialCrawl every refresh is a cheap full sweep, so the light/hot tier
    // is unnecessary; keep it on only in the Apify regime.
    enableLight: envBool("ENABLE_LIGHT_REFRESH", !scOn),
    enableDiscovery: envBool("ENABLE_DISCOVERY_REFRESH", true),
    enableComments: envBool("ENABLE_COMMENT_REFRESH", true),
    budgetTargetUsd: envFloat("APIFY_DAILY_BUDGET_TARGET_USD", 2),
    hardCapUsd: envFloat("APIFY_DAILY_HARD_CAP_USD", 3),
    estCostPerRunUsd: envFloat("APIFY_EST_COST_PER_RUN_USD", 0.02),
    socialcrawlEnabled: scOn,
    metricsDailyBudget: envInt("SC_METRICS_DAILY_BUDGET", 225),
    socialcrawlDailyCreditCap: getSocialcrawlDailyCreditCap(),
    quietHoursEnabled: envBool("REFRESH_QUIET_HOURS_ENABLED", true),
    quietTimezone:
      process.env.QUIET_HOURS_TIMEZONE || process.env.REFRESH_QUIET_HOURS_TIMEZONE || "America/New_York",
    // Approved quiet hours: 12:00 AM – 7:00 AM ET (end hour moved 6 → 7).
    quietStartHour: envHour("QUIET_HOURS_START_ET", envHour("REFRESH_QUIET_HOURS_START", 0)),
    quietEndHour: envHour("QUIET_HOURS_END_ET", envHour("REFRESH_QUIET_HOURS_END", 7)),
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

// The external scheduler fires at fixed quarter-hours but each refresh STARTS a
// few seconds after its tick, so the next tick can register as (interval − a few
// seconds) since the last start and be wrongly skipped as "not due" — leaving a
// 30-minute gap and a dashboard that reads older than the cadence. A small grace
// lets a tick that is within DUE_GRACE_MIN of the interval run. Safe: ticks are a
// full interval apart, so this never double-runs — and the refresh lock + the
// ~4-min scheduled-freshness window (refresh.ts) dominate, so keep DUE_GRACE_MIN
// well under that window (2 < 4) as a belt-and-suspenders invariant.
const DUE_GRACE_MIN = 2;

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
 * Full comment-detail (text) is pulled at most once per local day, at/after a
 * target hour. Comment COUNTS still come back every metrics refresh via the
 * cheap metric item — this only gates the expensive comment-text add-ons.
 * Pure + tested; quiet hours and the budget cap are enforced separately (and
 * before this) in decideScheduledRefresh.
 */
export function isCommentDetailDue(
  recentRuns: RefreshRun[],
  now: Date,
  cfg: RefreshPolicyConfig,
): boolean {
  if (!cfg.enableComments) return false;
  const tz = cfg.commentDetailTimezone;
  const h = localHour(now, tz);
  const today = localDateKey(now, tz);
  // The most recent comment-detail window whose start hour has passed today
  // (e.g. windows [12, 18] → at 13:00 the open window is 12; at 19:00 it's 18).
  const open = cfg.commentDetailWindows.filter((w) => h >= w).sort((a, b) => b - a)[0];
  if (open === undefined) return false; // before the first window today
  // One pull per window per day: if comment detail already ran at/after this
  // window's start today, it's already done.
  const lastAt = lastSuccessfulWhere(recentRuns, (m) => m.comments);
  if (lastAt) {
    const lastDate = localDateKey(new Date(lastAt), tz);
    const lastHour = localHour(new Date(lastAt), tz);
    if (lastDate === today && lastHour >= open) return false;
  }
  return true;
}

/**
 * Decide what a SCHEDULED (cron) ping is allowed to do right now.
 * `todaysActorRuns` = collection attempts recorded today (local budget day).
 */
export function decideScheduledRefresh(args: {
  now?: Date;
  recentRuns: RefreshRun[];
  todaysActorRuns: number;
  /** SocialCrawl credits used today (for the credit cap when SocialCrawl is on). */
  todaysSocialcrawlCredits?: number;
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

  // Budget cap. On SocialCrawl the basis is daily credits; on Apify it's the
  // estimated USD spend. Either way, scheduled refreshes stop when reached and
  // last-known-good is preserved.
  if (cfg.socialcrawlEnabled) {
    const credits = args.todaysSocialcrawlCredits ?? 0;
    if (credits >= cfg.socialcrawlDailyCreditCap) {
      // Cap reached: SocialCrawl METRICS must stop — but a due comment window or
      // discovery cycle still RUNS. The YouTube lane is FREE (Data API), and the
      // in-run SocialCrawl lane budgets clamp themselves to zero, so this spends
      // no SC credits. (The old unconditional skip here starved YouTube comments
      // + discovery for days whenever metrics were heavy — the July incident.)
      const commentsDue = isCommentDetailDue(args.recentRuns, now, cfg);
      const discoveryDue =
        cfg.enableDiscovery &&
        minutesSince(lastSuccessfulWhere(args.recentRuns, (m) => m.discovery), now) >= cfg.discoveryIntervalMin;
      if (commentsDue || discoveryDue) {
        return {
          action: "run",
          mode: { light: false, discovery: discoveryDue, comments: commentsDue },
          reason: `SocialCrawl cap reached (${credits}/${cfg.socialcrawlDailyCreditCap}) — running ${[
            discoveryDue ? "discovery" : null,
            commentsDue ? "comment" : null,
          ]
            .filter(Boolean)
            .join(" + ")} lane(s) only (YouTube is free; SC lanes clamp to 0)`,
        };
      }
      return {
        action: "skip",
        kind: "budget",
        reason: `Skipped: SocialCrawl daily credit cap reached (${credits}/${cfg.socialcrawlDailyCreditCap})`,
      };
    }
  } else {
    const estSpend = args.todaysActorRuns * cfg.estCostPerRunUsd;
    if (estSpend >= cfg.hardCapUsd) {
      return {
        action: "skip",
        kind: "budget",
        reason: `Skipped: estimated Apify spend today ($${estSpend.toFixed(2)}) reached the daily hard cap ($${cfg.hardCapUsd.toFixed(2)})`,
      };
    }
  }

  const lastFullAt = lastSuccessfulWhere(args.recentRuns, (m) => !m.light);
  const lastAnyAt = lastSuccessfulWhere(args.recentRuns, () => true);
  const lastDiscoveryAt = lastSuccessfulWhere(args.recentRuns, (m) => m.discovery);

  if (minutesSince(lastFullAt, now) >= cfg.fullIntervalMin - DUE_GRACE_MIN) {
    const discovery =
      cfg.enableDiscovery && minutesSince(lastDiscoveryAt, now) >= cfg.discoveryIntervalMin;
    // Comment detail: once per day at/after the target hour (cost control).
    const comments = isCommentDetailDue(args.recentRuns, now, cfg);
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

/**
 * SocialCrawl credit usage today, parsed from the collection-attempt log
 * (no schema change — credits are encoded in inputDescription as "<n>cr").
 * Cache hits cost 0 but still count as a call.
 */
export function socialcrawlCreditsToday(
  attempts: Array<{ provider: string; inputDescription: string; capturedAt: string; success?: boolean }>,
  now: Date,
  tz: string,
): { credits: number; calls: number; cached: number; failed: number } {
  const today = localDateKey(now, tz);
  let credits = 0;
  let calls = 0;
  let cached = 0;
  let failed = 0;
  for (const a of attempts) {
    if (a.provider !== "socialcrawl") continue;
    if (localDateKey(new Date(a.capturedAt), tz) !== today) continue;
    calls++;
    if (a.success === false) failed++;
    const m = a.inputDescription.match(/(\d+)cr/);
    credits += m ? Number(m[1]) : 1;
    if (/cache:hit/.test(a.inputDescription)) cached++;
  }
  return { credits, calls, cached, failed };
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

/**
 * Clamp a prospective scheduled-run time into active hours: anything that
 * lands inside the quiet window moves to the quiet-window end (config-driven,
 * default 7:00 AM ET) of that local day. Used for the admin "next due" display
 * so it never advertises an overnight run that the policy would skip.
 */
export function nextActiveTime(at: Date, cfg: RefreshPolicyConfig): Date {
  if (!cfg.quietHoursEnabled || !isQuietHours(at, cfg)) return at;
  // Walk forward hour by hour until outside the window, then snap to :00.
  // (Hour-resolution walk is DST-safe because isQuietHours re-derives the
  // local hour via Intl at every step.)
  let t = new Date(at);
  for (let i = 0; i < 12 && isQuietHours(t, cfg); i++) {
    t = new Date(t.getTime() + 60 * 60_000);
  }
  t.setMinutes(0, 0, 0);
  return t;
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
