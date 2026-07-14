// Apify cost-control policy: tiered cadences, quiet hours (DST-safe),
// budget caps, mode bookkeeping, and hot/warm/cold classification.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  classifyVideoHeat,
  decideScheduledRefresh,
  decodeRunMode,
  encodeRunMode,
  getRefreshPolicyConfig,
  isCommentDetailDue,
  isQuietHours,
  localHour,
  nextActiveTime,
  summarizeBudget,
  type RefreshPolicyConfig,
} from "@/lib/refresh-policy";
import type { RefreshRun } from "@/lib/types";
import { makeVideo } from "./helpers";

const REPO_ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf-8");

const CFG: RefreshPolicyConfig = {
  fullIntervalMin: 60,
  metricsDailyBudget: 225,
  lightIntervalMin: 30,
  discoveryIntervalMin: 720,
  discoveryLookbackHours: 72,
  commentsIntervalMin: 1440,
  commentDetailIntervalHours: 24,
  commentDetailHour: 9,
  commentDetailWindows: [9],
  commentDetailTimezone: "America/New_York",
  enableLight: false,
  enableDiscovery: true,
  enableComments: true,
  budgetTargetUsd: 2,
  hardCapUsd: 3,
  estCostPerRunUsd: 0.02,
  socialcrawlEnabled: false,
  socialcrawlDailyCreditCap: 300,
  quietHoursEnabled: true,
  quietTimezone: "America/New_York",
  quietStartHour: 0,
  quietEndHour: 6,
};

// 12:00 UTC = 08:00 EDT (active); 06:00 UTC = 02:00 EDT (quiet).
const ACTIVE = new Date("2026-06-12T12:00:00.000Z");
const QUIET = new Date("2026-06-12T06:00:00.000Z");

function run(partial: Partial<RefreshRun>): RefreshRun {
  return {
    id: Math.random().toString(36).slice(2),
    startedAt: "2026-06-12T11:00:00.000Z",
    finishedAt: "2026-06-12T11:03:00.000Z",
    status: "success",
    trigger: "cron",
    platformsAttempted: [],
    videosUpdated: 0,
    commentsUpdated: 0,
    newVideosDiscovered: 0,
    errors: [],
    rawLog: [encodeRunMode({ light: false, discovery: true, comments: true })],
    ...partial,
  } as RefreshRun;
}
const minsBefore = (d: Date, min: number) => new Date(d.getTime() - min * 60_000).toISOString();

describe("quiet hours (America/New_York, DST-safe)", () => {
  it("02:00 ET is quiet; 08:00 ET is active — in June (EDT, UTC-4)", () => {
    expect(isQuietHours(QUIET, CFG)).toBe(true);
    expect(isQuietHours(ACTIVE, CFG)).toBe(false);
  });
  it("the same window holds in January (EST, UTC-5) — DST does not break it", () => {
    // 06:00 UTC in January = 01:00 EST → quiet; 12:00 UTC = 07:00 EST → active.
    expect(isQuietHours(new Date("2026-01-12T06:00:00.000Z"), CFG)).toBe(true);
    expect(isQuietHours(new Date("2026-01-12T12:00:00.000Z"), CFG)).toBe(false);
    // Edge: 10:59 UTC January = 05:59 EST → still quiet; 11:00 UTC = 06:00 → active.
    expect(isQuietHours(new Date("2026-01-12T10:59:00.000Z"), CFG)).toBe(true);
    expect(isQuietHours(new Date("2026-01-12T11:00:00.000Z"), CFG)).toBe(false);
  });
  it("localHour really uses the configured timezone", () => {
    expect(localHour(new Date("2026-06-12T04:00:00.000Z"), "America/New_York")).toBe(0);
    expect(localHour(new Date("2026-01-12T05:00:00.000Z"), "America/New_York")).toBe(0);
  });
  it("scheduled refresh skips during quiet hours with the logged reason", () => {
    const d = decideScheduledRefresh({ now: QUIET, recentRuns: [], todaysActorRuns: 0, cfg: CFG });
    expect(d.action).toBe("skip");
    if (d.action === "skip") {
      expect(d.kind).toBe("quiet");
      expect(d.reason).toContain("quiet hours");
    }
  });
  it("disabled quiet hours never skip for time of day", () => {
    const d = decideScheduledRefresh({
      now: QUIET,
      recentRuns: [],
      todaysActorRuns: 0,
      cfg: { ...CFG, quietHoursEnabled: false },
    });
    expect(d.action).toBe("run");
  });
});

describe("midnight budget reset vs quiet hours (the order matters)", () => {
  // 12:30 AM EDT on Jun 13 = 04:30 UTC. Budget day key has flipped (counter
  // reset), but quiet hours must STILL block scheduled actor runs until 6 AM.
  const PAST_MIDNIGHT = new Date("2026-06-13T04:30:00.000Z");
  // 6:00 AM EDT = 10:00 UTC — first active moment.
  const SIX_AM = new Date("2026-06-13T10:00:00.000Z");
  it("after the midnight reset, scheduled runs STILL skip with 'quiet hours' (not budget)", () => {
    const d = decideScheduledRefresh({
      now: PAST_MIDNIGHT,
      recentRuns: [],
      todaysActorRuns: 0, // budget day reset — cap no longer the blocker
      cfg: CFG,
    });
    expect(d.action).toBe("skip");
    if (d.action === "skip") {
      expect(d.kind).toBe("quiet");
      expect(d.reason).toContain("Skipped: quiet hours");
    }
  });
  it("scheduled scraping resumes at 6:00 AM ET, not midnight", () => {
    expect(isQuietHours(PAST_MIDNIGHT, CFG)).toBe(true);
    expect(isQuietHours(SIX_AM, CFG)).toBe(false);
    const d = decideScheduledRefresh({
      now: SIX_AM,
      recentRuns: [],
      todaysActorRuns: 0,
      cfg: CFG,
    });
    expect(d.action).toBe("run");
  });
  it("nextActiveTime clamps overnight due-times to the 6 AM window end (admin display)", () => {
    const clamped = nextActiveTime(PAST_MIDNIGHT, CFG);
    expect(isQuietHours(clamped, CFG)).toBe(false);
    expect(localHour(clamped, CFG.quietTimezone)).toBe(6);
    // Active-hours times pass through untouched.
    expect(nextActiveTime(SIX_AM, CFG).getTime()).toBe(SIX_AM.getTime());
  });
});

describe("tiered cadence decisions", () => {
  it("runs a full refresh when none has happened in the interval", () => {
    const d = decideScheduledRefresh({
      now: ACTIVE,
      recentRuns: [run({ startedAt: minsBefore(ACTIVE, 90) })],
      todaysActorRuns: 10,
      cfg: CFG,
    });
    expect(d.action).toBe("run");
    if (d.action === "run") expect(d.mode.light).toBe(false);
  });
  it("skips cleanly when a full refresh ran recently and light mode is off", () => {
    const d = decideScheduledRefresh({
      now: ACTIVE,
      recentRuns: [run({ startedAt: minsBefore(ACTIVE, 30) })],
      todaysActorRuns: 10,
      cfg: CFG,
    });
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.kind).toBe("not_due");
  });
  it("light refresh runs between fulls when enabled", () => {
    const d = decideScheduledRefresh({
      now: ACTIVE,
      recentRuns: [run({ startedAt: minsBefore(ACTIVE, 35) })],
      todaysActorRuns: 10,
      cfg: { ...CFG, enableLight: true },
    });
    expect(d.action).toBe("run");
    if (d.action === "run") {
      expect(d.mode.light).toBe(true);
      expect(d.mode.discovery).toBe(false);
      expect(d.mode.comments).toBe(false);
    }
  });
  it("discovery is included only when due (12h)", () => {
    // Full due (90m > 60) but discovery NOT due (90m < 720). Comments are
    // gated separately (once/day) and not asserted here — ACTIVE is 08:00 ET,
    // before the 09:00 comment-detail hour.
    const d = decideScheduledRefresh({
      now: ACTIVE,
      recentRuns: [run({ startedAt: minsBefore(ACTIVE, 90) })],
      todaysActorRuns: 10,
      cfg: CFG,
    });
    expect(d.action).toBe("run");
    if (d.action === "run") {
      expect(d.mode.discovery).toBe(false);
      expect(d.mode.comments).toBe(false); // before 09:00 ET
    }
    // 13 hours later discovery is due again.
    const d2 = decideScheduledRefresh({
      now: ACTIVE,
      recentRuns: [run({ startedAt: minsBefore(ACTIVE, 13 * 60) })],
      todaysActorRuns: 10,
      cfg: CFG,
    });
    if (d2.action === "run") {
      expect(d2.mode.discovery).toBe(true);
    }
  });
  it("runs whose logs predate mode tracking count as full+discovery+comments", () => {
    const legacy = run({ startedAt: minsBefore(ACTIVE, 30), rawLog: ["something else"] });
    const d = decideScheduledRefresh({
      now: ACTIVE,
      recentRuns: [legacy],
      todaysActorRuns: 0,
      cfg: CFG,
    });
    expect(d.action).toBe("skip"); // full not due — legacy run counts
  });
});

describe("comment detail: once per day, at/after the target hour", () => {
  const EIGHT_AM = new Date("2026-06-12T12:00:00.000Z"); // 08:00 EDT
  const NINE_AM = new Date("2026-06-12T13:00:00.000Z"); // 09:00 EDT
  // A pull AT/AFTER the window satisfies it (window-based: a pre-window pull does not).
  const commentRunToday = () => run({ startedAt: NINE_AM.toISOString() }); // comments:on, at the window
  const metricsOnlyToday = () =>
    run({
      startedAt: minsBefore(NINE_AM, 30),
      rawLog: [encodeRunMode({ light: false, discovery: false, comments: false })],
    });

  it("is not due before the target hour", () => {
    expect(isCommentDetailDue([], EIGHT_AM, CFG)).toBe(false);
  });
  it("is due at/after the hour when no comment-detail run happened today", () => {
    expect(isCommentDetailDue([], NINE_AM, CFG)).toBe(true);
    // A metrics-only refresh today does NOT count as a comment-detail run.
    expect(isCommentDetailDue([metricsOnlyToday()], NINE_AM, CFG)).toBe(true);
  });
  it("is not due again once comment detail already ran today", () => {
    expect(isCommentDetailDue([commentRunToday()], NINE_AM, CFG)).toBe(false);
  });
  it("becomes due again the next local day", () => {
    const yesterday = run({ startedAt: "2026-06-11T13:30:00.000Z" }); // comments:on, prior day
    expect(isCommentDetailDue([yesterday], NINE_AM, CFG)).toBe(true);
  });
  it("respects the enableComments kill switch", () => {
    expect(isCommentDetailDue([], NINE_AM, { ...CFG, enableComments: false })).toBe(false);
  });
  it("a full refresh at/after the hour includes comments when due", () => {
    // Last refresh 90m ago (full due again) was metrics-only, so comment detail
    // has not run today → this full refresh includes comments.
    const d = decideScheduledRefresh({
      now: NINE_AM,
      recentRuns: [
        run({
          startedAt: minsBefore(NINE_AM, 90),
          rawLog: [encodeRunMode({ light: false, discovery: false, comments: false })],
        }),
      ],
      todaysActorRuns: 10,
      cfg: CFG,
    });
    expect(d.action).toBe("run");
    if (d.action === "run") expect(d.mode.comments).toBe(true);
  });
});

describe("budget cap", () => {
  it("skips scheduled refreshes once today's estimated spend reaches the hard cap", () => {
    const d = decideScheduledRefresh({
      now: ACTIVE,
      recentRuns: [run({ startedAt: minsBefore(ACTIVE, 90) })],
      todaysActorRuns: 150, // 150 × $0.02 = $3.00 → cap
      cfg: CFG,
    });
    expect(d.action).toBe("skip");
    if (d.action === "skip") {
      expect(d.kind).toBe("budget");
      expect(d.reason).toContain("hard cap");
    }
  });
  it("summarizeBudget flags over-target projections and cap state", () => {
    const b = summarizeBudget({ todaysActorRuns: 150, now: ACTIVE, cfg: CFG });
    expect(b.estSpendUsd).toBeCloseTo(3.0);
    expect(b.capReached).toBe(true);
    const ok = summarizeBudget({ todaysActorRuns: 20, now: ACTIVE, cfg: CFG });
    expect(ok.capReached).toBe(false);
  });
});

describe("run-mode bookkeeping", () => {
  it("encode/decode round-trips", () => {
    for (const m of [
      { light: false, discovery: true, comments: true },
      { light: true, discovery: false, comments: false },
      { light: false, discovery: false, comments: true },
    ]) {
      expect(decodeRunMode({ rawLog: [encodeRunMode(m)] })).toEqual(m);
    }
  });
  it("returns null for runs without a marker", () => {
    expect(decodeRunMode({ rawLog: ["tiktok: ok"] })).toBeNull();
    expect(decodeRunMode({ rawLog: null })).toBeNull();
  });
});

describe("hot/warm/cold classification", () => {
  const now = ACTIVE;
  it("fresh posts and top-ranked videos are hot", () => {
    expect(
      classifyVideoHeat({
        video: makeVideo({ publishedAt: minsBefore(now, 60) }),
        isTopRanked: false,
        gained24h: 0,
        now,
      }),
    ).toBe("hot");
    expect(
      classifyVideoHeat({
        video: makeVideo({ publishedAt: minsBefore(now, 30 * 24 * 60) }),
        isTopRanked: true,
        gained24h: 0,
        now,
      }),
    ).toBe("hot");
  });
  it("week-old posts with some growth are warm; old flat posts are cold", () => {
    expect(
      classifyVideoHeat({
        video: makeVideo({ publishedAt: minsBefore(now, 3 * 24 * 60) }),
        isTopRanked: false,
        gained24h: 10,
        now,
      }),
    ).toBe("warm");
    expect(
      classifyVideoHeat({
        video: makeVideo({ publishedAt: minsBefore(now, 30 * 24 * 60) }),
        isTopRanked: false,
        gained24h: 0,
        now,
      }),
    ).toBe("cold");
  });
});

describe("pipeline wiring (source-level)", () => {
  const refresh = read("src/lib/refresh.ts");
  it("cron runs go through the policy; manual/force bypass policy but never the lock", () => {
    expect(refresh).toContain('if (trigger === "cron")');
    expect(refresh).toContain("decideScheduledRefresh");
    // The lock gate runs BEFORE the policy gate for every trigger.
    expect(refresh.indexOf("evaluateRefreshGate(recent, trigger)")).toBeLessThan(
      refresh.indexOf("decideScheduledRefresh({"),
    );
  });
  it("every run records its mode marker for cadence bookkeeping", () => {
    expect(refresh).toContain("log.unshift(encodeRunMode(mode))");
  });
  it("light mode targets hot videos and defers the YouTube/Facebook sweep", () => {
    expect(refresh).toContain("pickHotVideos");
    expect(refresh).toContain("sweep deferred to the next full refresh");
  });
  it("comments are ingested only when the mode allows", () => {
    expect(refresh).toContain("mode.comments");
  });
  it("force refresh shows a cost warning in the admin UI", () => {
    const btn = read("src/components/ui/refresh-button.tsx");
    expect(btn).toContain("may run multiple Apify actors and use credits");
  });
  it("public quiet-hours copy exists and public users still cannot refresh", () => {
    const note = read("src/components/ui/auto-refresh-note.tsx");
    expect(note).toContain("Refresh paused overnight · resumes ");
    const page = read("src/app/page.tsx");
    expect(page).not.toContain("RefreshButton");
  });
  it("env knobs exist with safe defaults", () => {
    const cfg = getRefreshPolicyConfig();
    expect(cfg.fullIntervalMin).toBe(60);
    expect(cfg.discoveryIntervalMin).toBe(120); // every 2 active hours (launch cadence)
    expect(cfg.discoveryLookbackHours).toBe(72); // auto-add window
    expect(cfg.commentsIntervalMin).toBe(1440); // once a day
    expect(cfg.commentDetailIntervalHours).toBe(24);
    expect(cfg.commentDetailHour).toBe(12); // first comment-detail window (12:00 ET)
    expect(cfg.commentDetailTimezone).toBe("America/New_York");
    expect(cfg.quietTimezone).toBe("America/New_York");
    expect(cfg.hardCapUsd).toBeGreaterThan(0);
  });
});
