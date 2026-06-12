// Scheduler metadata + refresh-health computation.
//
// The production refresh cadence is owned by cron-job.org (NOT Vercel cron,
// NOT GitHub Actions — GitHub's free-tier cron lagged by 1.4–2.2 hours).
// This module is the single source of truth the admin panel and the public
// refresh note read from. The cron-job.org account API key is read from the
// server-only CRONJOB_ORG_API_KEY env var and is never returned to callers.

export interface SchedulerInfo {
  type: "cron-job.org";
  jobId: number;
  jobName: string;
  cadenceMinutes: number;
  /** Set true only after the job was created, enabled, test-run, and seen in
   * production logs. Gates the public "every 5 minutes" claim. */
  verified: boolean;
  backup: string;
}

export const SCHEDULER: SchedulerInfo = {
  type: "cron-job.org",
  jobId: 7793727,
  jobName: "Wachter Campaign Dashboard Refresh",
  cadenceMinutes: 5,
  verified: true, // verified live 2026-06-12: 202 responses + cron-triggered runs in Supabase
  backup: "GitHub Actions every 30 min (best-effort backup)",
};

/** Public wording thresholds (Part 7): minutes since last successful refresh. */
export const REFRESH_DELAYED_AFTER_MIN = 8;
export const SCHEDULER_DELAYED_AFTER_MIN = 15;

export type RefreshHealth = "healthy" | "delayed" | "failed" | "unknown";

export function computeRefreshHealth(args: {
  lastSuccessAt: string | null;
  lastAttemptStatus: string | null;
  now?: Date;
}): RefreshHealth {
  const { lastSuccessAt, lastAttemptStatus } = args;
  const now = args.now ?? new Date();
  if (!lastSuccessAt) return lastAttemptStatus === "failed" ? "failed" : "unknown";
  const ageMin = (now.getTime() - new Date(lastSuccessAt).getTime()) / 60_000;
  if (ageMin <= REFRESH_DELAYED_AFTER_MIN) return "healthy";
  if (lastAttemptStatus === "failed") return "failed";
  return "delayed";
}

export interface SchedulerLiveStatus {
  enabled: boolean;
  lastExecutionAt: string | null;
  nextExecutionAt: string | null;
  /** cron-job.org lastStatus: 0 unknown, 1 OK, others = failure kinds. */
  lastStatusOk: boolean | null;
}

/**
 * Live job status straight from cron-job.org — server-side only. Returns
 * null when the API key isn't configured or the API is unreachable; callers
 * fall back to static SCHEDULER metadata. Never throws, never leaks the key.
 */
export async function getSchedulerLiveStatus(): Promise<SchedulerLiveStatus | null> {
  const key = process.env.CRONJOB_ORG_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://api.cron-job.org/jobs/${SCHEDULER.jobId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      jobDetails?: {
        enabled?: boolean;
        lastExecution?: number;
        nextExecution?: number | null;
        lastStatus?: number;
      };
    };
    const j = data.jobDetails;
    if (!j) return null;
    return {
      enabled: Boolean(j.enabled),
      lastExecutionAt: j.lastExecution ? new Date(j.lastExecution * 1000).toISOString() : null,
      nextExecutionAt: j.nextExecution ? new Date(j.nextExecution * 1000).toISOString() : null,
      lastStatusOk: j.lastStatus === undefined ? null : j.lastStatus === 1,
    };
  } catch {
    return null;
  }
}
