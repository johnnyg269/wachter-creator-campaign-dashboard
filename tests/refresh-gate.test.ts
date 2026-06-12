// Phase 3.3b: refresh gate (lock + freshness), public read-only guarantees,
// 5-minute scheduler wiring, and comment-delta wording.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  evaluateRefreshGate,
  MANUAL_FRESHNESS_WINDOW_MS,
  REFRESH_LOCK_TTL_MS,
  SCHEDULED_FRESHNESS_WINDOW_MS,
} from "@/lib/refresh";
import { describeCommentDelta } from "@/lib/format";
import { makeRefreshRun } from "./helpers";

const NOW = new Date("2026-06-11T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("evaluateRefreshGate — overlap lock", () => {
  it("skips every trigger while a fresh run is in progress", () => {
    const runs = [makeRefreshRun({ status: "running", startedAt: ago(60_000) })];
    for (const trigger of ["cron", "manual", "force", "script"] as const) {
      const d = evaluateRefreshGate(runs, trigger, NOW);
      expect(d.action).toBe("skip");
      if (d.action === "skip") {
        expect(d.kind).toBe("locked");
        expect(d.reason).toBe("Refresh already running, skipped.");
      }
    }
  });
  it("expires a stale lock instead of blocking forever", () => {
    const stale = makeRefreshRun({
      status: "running",
      startedAt: ago(REFRESH_LOCK_TTL_MS + 60_000),
    });
    const d = evaluateRefreshGate([stale], "cron", NOW);
    expect(d.action).toBe("run");
    expect(d.staleRunIds).toEqual([stale.id]);
  });
});

describe("evaluateRefreshGate — manual freshness throttle", () => {
  const recentSuccess = makeRefreshRun({
    status: "success",
    startedAt: ago(2 * 60_000),
    finishedAt: ago(60_000),
  });
  it("blocks plain manual refresh within 3 minutes of a success", () => {
    const d = evaluateRefreshGate([recentSuccess], "manual", NOW);
    expect(d.action).toBe("skip");
    if (d.action === "skip") {
      expect(d.kind).toBe("fresh");
      expect(d.reason).toBe(
        "Data refreshed recently. Next automatic refresh will run shortly.",
      );
    }
  });
  it("force bypasses freshness", () => {
    expect(evaluateRefreshGate([recentSuccess], "force", NOW).action).toBe("run");
  });
  it("allows manual refresh after the window passes", () => {
    const older = makeRefreshRun({
      status: "success",
      startedAt: ago(MANUAL_FRESHNESS_WINDOW_MS + 120_000),
      finishedAt: ago(MANUAL_FRESHNESS_WINDOW_MS + 60_000),
    });
    expect(evaluateRefreshGate([older], "manual", NOW).action).toBe("run");
  });
});

describe("evaluateRefreshGate — scheduled freshness throttle", () => {
  it("skips a cron refresh when a success STARTED less than 4 minutes ago", () => {
    const justRan = makeRefreshRun({
      status: "success",
      startedAt: ago(2 * 60_000),
      finishedAt: ago(60_000),
    });
    const d = evaluateRefreshGate([justRan], "cron", NOW);
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.kind).toBe("fresh");
  });
  it("runs the next 5-minute tick even when the previous ~3-minute run only just finished", () => {
    // Started 5 min ago, finished 2 min ago — measuring from finishedAt here
    // would silently halve the 5-minute cadence; startedAt is the contract.
    const longRun = makeRefreshRun({
      status: "success",
      startedAt: ago(SCHEDULED_FRESHNESS_WINDOW_MS + 60_000),
      finishedAt: ago(2 * 60_000),
    });
    expect(evaluateRefreshGate([longRun], "cron", NOW).action).toBe("run");
  });
  it("partial successes also count as freshness", () => {
    const partial = makeRefreshRun({
      status: "partial",
      startedAt: ago(60_000),
      finishedAt: ago(30_000),
    });
    expect(evaluateRefreshGate([partial], "cron", NOW).action).toBe("skip");
  });
  it("script trigger is never freshness-blocked", () => {
    const fresh = makeRefreshRun({
      status: "success",
      startedAt: ago(60_000),
      finishedAt: ago(30_000),
    });
    expect(evaluateRefreshGate([fresh], "script", NOW).action).toBe("run");
  });
});

describe("public read-only guarantees (source-level)", () => {
  const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
  it.each([
    "src/app/page.tsx",
    "src/app/videos/page.tsx",
    "src/app/comments/page.tsx",
    "src/app/platforms/page.tsx",
    "src/app/episodes/page.tsx",
    "src/app/alerts/page.tsx",
  ])("%s renders no refresh button and never calls refresh endpoints", (p) => {
    const src = read(p);
    expect(src).not.toContain("RefreshButton");
    expect(src).not.toContain("/api/refresh");
    expect(src).not.toContain("/api/cron/refresh");
  });
  it("the public dashboard states the auto-refresh cadence only when the scheduler is verified", () => {
    const note = read("src/components/ui/auto-refresh-note.tsx");
    expect(note).toContain("Auto-refreshes every");
    // The cadence claim must be gated on verified scheduler metadata…
    expect(note).toContain("SCHEDULER.verified");
    // …and degrade honestly when the data ages past the thresholds.
    expect(note).toContain("Refresh delayed, latest data shown");
    expect(note).toContain("Scheduler may be delayed");
    expect(note).toContain("Last successful refresh");
  });
  it("/api/refresh requires the admin session", () => {
    const src = read("src/app/api/refresh/route.ts");
    expect(src).toContain("checkAdminRequest");
    expect(src).toContain("401");
  });
  it("CRON_SECRET is only read server-side (no NEXT_PUBLIC_)", () => {
    const config = read("src/lib/config.ts");
    expect(config).not.toContain("NEXT_PUBLIC_CRON");
  });
});

describe("5-minute scheduler wiring", () => {
  it("GitHub Actions workflow is a 30-minute best-effort backup (cron-job.org is primary)", () => {
    const wf = readFileSync(
      path.join(process.cwd(), ".github/workflows/refresh.yml"),
      "utf-8",
    );
    // Primary cadence lives on cron-job.org (job 7793727). GitHub's cron is
    // backup-only at 30 minutes — the unreliable 5-minute schedule must not
    // silently come back and compete with the primary.
    expect(wf).toContain('cron: "*/30 * * * *"');
    expect(wf).not.toContain('cron: "*/5');
    expect(wf).toContain("BACKUP");
    expect(wf).toContain("workflow_dispatch");
    expect(wf).toContain("Authorization: Bearer ${CRON_SECRET}");
    expect(wf).toContain("secrets.CRON_SECRET");
    // never hardcoded
    expect(wf).not.toMatch(/Bearer [a-f0-9]{16,}/);
  });
});

describe("describeCommentDelta wording", () => {
  it("zero reads as no new comments", () => {
    expect(describeCommentDelta(0).text).toBe("No new comments 24h");
  });
  it("positive reads as +X new comments", () => {
    expect(describeCommentDelta(2).text).toBe("+2 new comments 24h");
    expect(describeCommentDelta(1).text).toBe("+1 new comment 24h");
  });
  it("negative never shows a raw minus count", () => {
    const d = describeCommentDelta(-1);
    expect(d.text).toBe("Comment count changed");
    expect(d.text).not.toContain("-1");
    expect(d.tooltip).toMatch(/lower comment count/);
  });
  it("unavailable is not treated as zero", () => {
    const d = describeCommentDelta(null);
    expect(d.text).not.toBe("No new comments 24h");
    expect(d.tooltip).toBe("Not enough data yet");
  });
});
