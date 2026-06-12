// Admin → Refresh Health: the live truth about the scheduler and the gate.
// Reads static scheduler metadata + (when CRONJOB_ORG_API_KEY is set) live
// job status from cron-job.org. Never renders any secret value.

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TimeAgo } from "@/components/ui/time-ago";
import { formatDateTime } from "@/lib/format";
import { REFRESH_LOCK_TTL_MS } from "@/lib/refresh";
import {
  SCHEDULER,
  computeRefreshHealth,
  getSchedulerLiveStatus,
  type RefreshHealth,
} from "@/lib/scheduler";
import type { RefreshRun } from "@/lib/types";

const HEALTH_STYLE: Record<RefreshHealth, { label: string; cls: string }> = {
  healthy: { label: "Healthy", cls: "text-positive" },
  delayed: { label: "Delayed", cls: "text-warning" },
  failed: { label: "Failed", cls: "text-negative" },
  unknown: { label: "Unknown", cls: "text-muted" },
};

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-strong">{label}</div>
      <div className="mt-1 font-medium">{children}</div>
    </div>
  );
}

function runDurationSec(r: RefreshRun): number | null {
  if (!r.finishedAt) return null;
  return Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000);
}

export async function RefreshHealthPanel({ runs }: { runs: RefreshRun[] }) {
  const live = await getSchedulerLiveStatus();

  const attempts = runs.filter((r) => r.status !== "skipped");
  const lastAttempt = attempts[0] ?? null;
  const lastSuccess = attempts.find((r) => r.status === "success" || r.status === "partial") ?? null;
  const lastSkipped = runs.find((r) => r.status === "skipped") ?? null;
  const lastFailed = attempts.find((r) => r.status === "failed") ?? null;
  // Server component rendered per-request — wall-clock lock age is the point.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const lock = runs.find(
    (r) => r.status === "running" && now - new Date(r.startedAt).getTime() < REFRESH_LOCK_TTL_MS,
  );

  const completed = attempts.filter((r) => r.finishedAt && r.status !== "running");
  const durations = completed.map(runDurationSec).filter((d): d is number => d !== null);
  const avgDuration = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;
  const lastDuration = lastSuccess ? runDurationSec(lastSuccess) : null;

  const health = computeRefreshHealth({
    lastSuccessAt: lastSuccess ? (lastSuccess.finishedAt ?? lastSuccess.startedAt) : null,
    lastAttemptStatus: lastAttempt?.status ?? null,
  });
  const h = HEALTH_STYLE[health];

  return (
    <Card>
      <CardHeader
        title="Refresh health"
        subtitle={`Primary scheduler: ${SCHEDULER.type} · ${SCHEDULER.backup}`}
      />
      <CardBody className="space-y-4 text-xs">
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Refresh health">
            <span className={h.cls}>{h.label}</span>
            <span className="block text-[10px] font-normal text-muted-strong">
              Healthy = success within 8 min of cadence
            </span>
          </Stat>
          <Stat label="Active scheduler">
            {SCHEDULER.type}
            <span className="block text-[10px] font-normal text-muted-strong">
              “{SCHEDULER.jobName}” · job #{SCHEDULER.jobId}
            </span>
          </Stat>
          <Stat label="Expected cadence">
            Every {SCHEDULER.cadenceMinutes} minutes
            <span className="block text-[10px] font-normal text-muted-strong">
              Backup: {SCHEDULER.backup}
            </span>
          </Stat>
          <Stat label="Scheduler job status">
            {live ? (
              <>
                <span className={live.enabled ? "text-positive" : "text-negative"}>
                  {live.enabled ? "Enabled" : "DISABLED"}
                </span>
                {live.lastStatusOk !== null && (
                  <span className={live.lastStatusOk ? "text-positive" : "text-warning"}>
                    {" "}
                    · last ping {live.lastStatusOk ? "OK" : "failed"}
                  </span>
                )}
                <span className="block text-[10px] font-normal text-muted-strong">
                  {live.lastExecutionAt && (
                    <>
                      last <TimeAgo iso={live.lastExecutionAt} />
                      {" · "}
                    </>
                  )}
                  {live.nextExecutionAt && <>next {formatDateTime(live.nextExecutionAt)}</>}
                </span>
              </>
            ) : (
              <>
                {SCHEDULER.verified ? "Verified" : "Unverified"}
                <span className="block text-[10px] font-normal text-muted-strong">
                  Set CRONJOB_ORG_API_KEY for live job status
                </span>
              </>
            )}
          </Stat>
          <Stat label="Last attempted refresh">
            {lastAttempt ? (
              <>
                {lastAttempt.status} · <TimeAgo iso={lastAttempt.startedAt} />
                <span className="block text-[10px] font-normal text-muted-strong">
                  trigger: {lastAttempt.trigger}
                </span>
              </>
            ) : (
              "none yet"
            )}
          </Stat>
          <Stat label="Last successful refresh">
            {lastSuccess ? (
              <>
                <TimeAgo iso={lastSuccess.finishedAt ?? lastSuccess.startedAt} />
                <span className="block text-[10px] font-normal text-muted-strong">
                  {lastSuccess.videosUpdated} videos · {lastSuccess.commentsUpdated} comments
                </span>
              </>
            ) : (
              "none yet"
            )}
          </Stat>
          <Stat label="Last skipped / failed">
            {lastSkipped ? (
              <>
                skipped <TimeAgo iso={lastSkipped.startedAt} />
              </>
            ) : (
              "no recent skips"
            )}
            <span className="block text-[10px] font-normal text-muted-strong">
              {lastFailed ? (
                <>
                  last failure <TimeAgo iso={lastFailed.startedAt} />
                </>
              ) : (
                "no recent failures"
              )}
            </span>
          </Stat>
          <Stat label="Refresh lock">
            {lock ? (
              <span className="text-accent">Locked — {lock.trigger} refresh in progress</span>
            ) : (
              <span className="text-positive">Unlocked</span>
            )}
            <span className="block text-[10px] font-normal text-muted-strong">
              {lock ? (
                <>
                  since {formatDateTime(lock.startedAt)} · expires{" "}
                  {formatDateTime(new Date(new Date(lock.startedAt).getTime() + REFRESH_LOCK_TTL_MS).toISOString())}
                </>
              ) : (
                `One refresh at a time · stale locks expire after ${REFRESH_LOCK_TTL_MS / 60_000} min`
              )}
            </span>
          </Stat>
          <Stat label="Refresh duration">
            {lastDuration !== null ? `${lastDuration}s last` : "—"}
            <span className="block text-[10px] font-normal text-muted-strong">
              {avgDuration !== null ? `${avgDuration}s average (recent runs)` : "no completed runs yet"}
            </span>
          </Stat>
        </div>

        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <div className="font-medium">Endpoint</div>
          <code className="mt-1 block break-all font-mono text-[11px] text-muted">
            POST https://wachter-creator-campaign-dashboard.vercel.app/api/cron/refresh
          </code>
          <div className="mt-2 font-medium">Required header</div>
          <code className="mt-1 block font-mono text-[11px] text-muted">
            Authorization: Bearer &lt;CRON_SECRET&gt;
          </code>
          <p className="mt-1 text-[11px] text-muted-strong">
            The endpoint answers 202 immediately and refreshes in the background (cron-job.org
            free tier caps requests at 30s). Secrets are never displayed here. Overlaps are
            impossible — the database-backed lock skips concurrent runs; scheduled refreshes
            skip when a success started less than 4 minutes ago; manual refreshes within 3
            minutes of a success are declined (Force refresh bypasses freshness, never the
            lock).
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
