// Scheduler wiring (cron-job.org primary), refresh-health computation, and
// secret-hygiene guarantees around the scheduler integration.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { GET, POST } from "@/app/api/cron/refresh/route";
import { NextRequest } from "next/server";
import {
  REFRESH_DELAYED_AFTER_MIN,
  SCHEDULER,
  SCHEDULER_DELAYED_AFTER_MIN,
  computeRefreshHealth,
} from "@/lib/scheduler";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

describe("scheduler metadata", () => {
  it("cron-job.org is the primary scheduler at a 15-minute metrics cadence", () => {
    expect(SCHEDULER.type).toBe("cron-job.org");
    expect(SCHEDULER.cadenceMinutes).toBe(15);
    expect(SCHEDULER.jobId).toBeGreaterThan(0);
    expect(SCHEDULER.jobName).toBe("Wachter Campaign Dashboard Refresh");
    expect(SCHEDULER.backup).toContain("GitHub Actions");
  });
  it("delay thresholds tolerate one missed tick (2x+3 / 3x+3 of the cadence)", () => {
    // Loosened from 1.5x/2.5x: a single missed/slow 15-min tick pushes data age
    // to ~30 min, which must NOT read as "delayed". 2x+3=33, 3x+3=48.
    expect(REFRESH_DELAYED_AFTER_MIN).toBe(SCHEDULER.cadenceMinutes * 2 + 3);
    expect(SCHEDULER_DELAYED_AFTER_MIN).toBe(SCHEDULER.cadenceMinutes * 3 + 3);
    expect(REFRESH_DELAYED_AFTER_MIN).toBeGreaterThan(30); // one missed tick is fine
  });
});

describe("computeRefreshHealth", () => {
  const NOW = new Date("2026-06-12T12:00:00.000Z");
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  it("healthy when the last success is within the delayed threshold", () => {
    // A 15-min-old success is well within the 33-min threshold.
    expect(
      computeRefreshHealth({ lastSuccessAt: ago(15), lastAttemptStatus: "success", now: NOW }),
    ).toBe("healthy");
  });
  it("a single missed tick (26m old) is still healthy — no spurious 'delayed'", () => {
    // Regression guard: the old 22.5-min threshold flagged this benign case.
    expect(
      computeRefreshHealth({ lastSuccessAt: ago(26), lastAttemptStatus: "success", now: NOW }),
    ).toBe("healthy");
  });
  it("delayed once genuinely behind (older than ~2 missed ticks)", () => {
    expect(
      computeRefreshHealth({ lastSuccessAt: ago(40), lastAttemptStatus: "success", now: NOW }),
    ).toBe("delayed");
    expect(
      computeRefreshHealth({ lastSuccessAt: ago(120), lastAttemptStatus: "success", now: NOW }),
    ).toBe("delayed");
  });
  it("failed when stale AND the latest attempt failed", () => {
    expect(
      computeRefreshHealth({ lastSuccessAt: ago(200), lastAttemptStatus: "failed", now: NOW }),
    ).toBe("failed");
  });
  it("an overnight-old success is healthy during quiet hours", () => {
    expect(
      computeRefreshHealth({
        lastSuccessAt: ago(5 * 60),
        lastAttemptStatus: "skipped",
        quietHours: true,
        now: NOW,
      }),
    ).toBe("healthy");
  });
  it("unknown with no data at all", () => {
    expect(computeRefreshHealth({ lastSuccessAt: null, lastAttemptStatus: null, now: NOW })).toBe(
      "unknown",
    );
  });
});

describe("/api/cron/refresh authentication", () => {
  const url = "http://localhost/api/cron/refresh";
  it("rejects a missing bearer token with 401 (GET and POST)", async () => {
    process.env.CRON_SECRET = "test-secret-for-auth-check";
    expect((await GET(new NextRequest(url))).status).toBe(401);
    expect((await POST(new NextRequest(url, { method: "POST" }))).status).toBe(401);
  });
  it("rejects a wrong bearer token with 401", async () => {
    process.env.CRON_SECRET = "test-secret-for-auth-check";
    const req = new NextRequest(url, {
      headers: { authorization: "Bearer wrong-value" },
    });
    expect((await GET(req)).status).toBe(401);
  });
  it("refuses to run entirely when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const req = new NextRequest(url, {
      headers: { authorization: "Bearer anything" },
    });
    expect((await GET(req)).status).toBe(401);
  });
});

describe("scheduler secret hygiene (source-level)", () => {
  it("the cron-job.org API key is read server-side only, never NEXT_PUBLIC", () => {
    const scheduler = read("src/lib/scheduler.ts");
    expect(scheduler).toContain("process.env.CRONJOB_ORG_API_KEY");
    expect(scheduler).not.toContain("NEXT_PUBLIC");
  });
  it("no component ships the cron-job.org key or a NEXT_PUBLIC variant of it", () => {
    for (const p of [
      "src/app/admin/refresh-health.tsx",
      "src/components/ui/auto-refresh-note.tsx",
    ]) {
      const src = read(p);
      expect(src).not.toContain("NEXT_PUBLIC_CRONJOB");
      // Components may only consume derived status objects, never the env var.
      expect(src).not.toContain("CRONJOB_ORG_API_KEY=");
    }
  });
  it("the cron route never logs or returns the secret", () => {
    const route = read("src/app/api/cron/refresh/route.ts");
    expect(route).not.toMatch(/console\.(log|error)\([^)]*secret/i);
    expect(route).toContain("Bearer ${secret}");
  });
  it("the route responds fast (202 + after) and supports GET and POST", () => {
    const route = read("src/app/api/cron/refresh/route.ts");
    expect(route).toContain("after(");
    expect(route).toContain("202");
    expect(route).toContain("export async function GET");
    expect(route).toContain("export async function POST");
  });
  it("admin Refresh Health presents cron-job.org as the active scheduler", () => {
    const panel = read("src/app/admin/refresh-health.tsx");
    expect(panel).toContain("SCHEDULER");
    expect(panel).toContain("Refresh health");
    const lib = read("src/lib/scheduler.ts");
    expect(lib).toContain('"cron-job.org"');
  });
  it("secrets-check covers cron-job.org API key patterns", () => {
    const sh = read("scripts/secrets-check.sh");
    expect(sh).toContain("CRONJOB_ORG_API_KEY=");
  });
});
