// Admin → Refresh Health: the live truth about the scheduler and the gate.
// Reads static scheduler metadata + (when CRONJOB_ORG_API_KEY is set) live
// job status from cron-job.org. Never renders any secret value.

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TimeAgo } from "@/components/ui/time-ago";
import { AnimatedText } from "@/components/ui/animated-text";
import { formatDateTime } from "@/lib/format";
import { REFRESH_LOCK_TTL_MS } from "@/lib/refresh";
import {
  REFRESH_DELAYED_AFTER_MIN,
  SCHEDULER,
  computeRefreshHealth,
  getSchedulerLiveStatus,
  type RefreshHealth,
} from "@/lib/scheduler";
import {
  decodeRunMode,
  getRefreshPolicyConfig,
  isQuietHours,
  localDateKey,
  nextActiveTime,
  socialcrawlCreditsToday,
  summarizeBudget,
} from "@/lib/refresh-policy";
import { getStore } from "@/lib/store";
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
  const cfg = getRefreshPolicyConfig();
  const nowDate = new Date();
  const quiet = isQuietHours(nowDate, cfg);

  // Today's actor runs (budget day = quiet-hours timezone).
  const actorAttempts = await getStore().listCollectionAttempts(500);
  const todayKey = localDateKey(nowDate, cfg.quietTimezone);
  const todaysActorRuns = actorAttempts.filter(
    (a) => localDateKey(new Date(a.capturedAt), cfg.quietTimezone) === todayKey,
  ).length;
  const budget = summarizeBudget({ todaysActorRuns, now: nowDate, cfg });
  const sc = socialcrawlCreditsToday(actorAttempts, nowDate, cfg.quietTimezone);
  const scProjected =
    sc.credits > 0 && cfg.socialcrawlEnabled
      ? Math.round((sc.credits / Math.max(1, 24 - cfg.quietEndHour)) * (24 - (cfg.quietEndHour - cfg.quietStartHour)))
      : sc.credits;

  // Mode bookkeeping from run logs.
  const successRuns = runs.filter((r) => r.status === "success" || r.status === "partial");
  const lastModeRun = successRuns.find((r) => decodeRunMode(r) !== null) ?? successRuns[0] ?? null;
  const lastMode = lastModeRun ? decodeRunMode(lastModeRun) : null;
  const lastFullAt =
    successRuns.find((r) => !(decodeRunMode(r)?.light ?? false))?.startedAt ?? null;
  const lastDiscoveryAt =
    successRuns.find((r) => decodeRunMode(r)?.discovery ?? true)?.startedAt ?? null;
  const lastCommentsAt =
    successRuns.find((r) => decodeRunMode(r)?.comments ?? true)?.startedAt ?? null;
  const lastQuietSkip = runs.find(
    (r) => r.status === "skipped" && r.rawLog?.[0]?.includes("quiet hours"),
  );
  // "Next due" never advertises an overnight time the policy would skip —
  // anything landing in quiet hours clamps to the 6:00 AM ET window end.
  const nextDue = (lastAt: string | null, intervalMin: number) =>
    nextActiveTime(
      lastAt ? new Date(new Date(lastAt).getTime() + intervalMin * 60_000) : nowDate,
      cfg,
    ).toISOString();

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
    quietHours: quiet,
  });
  const h = HEALTH_STYLE[health];

  // Skipped-refresh reasons (recent window) — cost-control transparency. The
  // skip kind is encoded in rawLog[0] as "skipped (<kind>): <reason>".
  const skipKinds: Record<string, number> = {};
  for (const r of runs) {
    if (r.status !== "skipped") continue;
    const kind = r.rawLog?.[0]?.match(/skipped \(([a-z_]+)\)/i)?.[1] ?? "other";
    skipKinds[kind] = (skipKinds[kind] ?? 0) + 1;
  }
  const skipTotal = Object.values(skipKinds).reduce((a, b) => a + b, 0);
  const skipSummary = Object.entries(skipKinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ");

  // Busiest source today by actor-run count — a no-cost proxy for the most
  // expensive platform (per-run USD lives in the Apify console, not here).
  const PLATFORM_LABEL: Record<string, string> = {
    tiktok: "TikTok",
    instagram: "Instagram",
    facebook: "Facebook",
    youtube: "YouTube",
  };
  const runsByPlatformToday: Record<string, number> = {};
  for (const a of actorAttempts) {
    if (localDateKey(new Date(a.capturedAt), cfg.quietTimezone) !== todayKey) continue;
    runsByPlatformToday[a.platform] = (runsByPlatformToday[a.platform] ?? 0) + 1;
  }
  const busiest = Object.entries(runsByPlatformToday).sort((a, b) => b[1] - a[1])[0] ?? null;

  return (
    <Card>
      <CardHeader
        title="Refresh health"
        subtitle={`Primary scheduler: ${SCHEDULER.type} · ${SCHEDULER.backup}`}
      />
      <CardBody className="space-y-4 text-xs">
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="Refresh health">
            <AnimatedText className={h.cls} text={h.label} />
            <span className="block text-[10px] font-normal text-muted-strong">
              Healthy = success within {REFRESH_DELAYED_AFTER_MIN} min (~2 refresh cycles)
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

        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {cfg.socialcrawlEnabled ? (
            <Stat label="SocialCrawl credits today">
              <span className={sc.credits >= cfg.socialcrawlDailyCreditCap ? "text-negative" : scProjected > cfg.socialcrawlDailyCreditCap ? "text-warning" : "text-positive"}>
                {sc.credits}/{cfg.socialcrawlDailyCreditCap}
              </span>
              <span className="block text-[10px] font-normal text-muted-strong">
                {sc.calls} calls · {sc.cached} cache hits · {sc.failed} failed · projected ~{scProjected}/day
                {sc.credits >= cfg.socialcrawlDailyCreditCap && " — CAP REACHED, scheduled refreshes paused"}
              </span>
            </Stat>
          ) : (
            <Stat label="Apify cost today (est.)">
              <span className={budget.capReached ? "text-negative" : budget.overTarget ? "text-warning" : "text-positive"}>
                ${budget.estSpendUsd.toFixed(2)}
              </span>
              <span className="block text-[10px] font-normal text-muted-strong">
                {budget.runsToday} actor runs · projected ${budget.projectedDayUsd.toFixed(2)}/day ·
                target ${budget.targetUsd.toFixed(2)} · hard cap ${budget.hardCapUsd.toFixed(2)}
                {budget.capReached && " — CAP REACHED, scheduled refreshes paused"}
              </span>
            </Stat>
          )}
          <Stat label="Latest refresh mode">
            {lastMode ? (lastMode.light ? "Light (hot videos)" : "Full") : "Full (pre-policy)"}
            <span className="block text-[10px] font-normal text-muted-strong">
              {lastMode
                ? `discovery ${lastMode.discovery ? "on" : "off"} · comments ${lastMode.comments ? "on" : "off"}`
                : "mode tracking starts with the next refresh"}
            </span>
          </Stat>
          <Stat label="Comment detail">
            {cfg.commentDetailWindows.length}×/day at{" "}
            {cfg.commentDetailWindows.map((w) => `${String(w).padStart(2, "0")}:00`).join(", ")}{" "}
            {cfg.commentDetailTimezone}
            <span className="block text-[10px] font-normal text-muted-strong">
              Detail (Facebook per-post engagement) pulled {cfg.commentDetailWindows.length}× per active
              day; metric-only refreshes skip it. Counts still update each refresh.
            </span>
          </Stat>
          <Stat label="Metrics cadence">
            Full every {cfg.fullIntervalMin}m{cfg.enableLight ? ` · hot every ${cfg.lightIntervalMin}m` : ""}
            <span className="block text-[10px] font-normal text-muted-strong">
              discovery every {Math.round(cfg.discoveryIntervalMin / 60)}h · budget cap still wins
            </span>
          </Stat>
          <Stat label="Next due">
            full {formatDateTime(nextDue(lastFullAt, cfg.fullIntervalMin))}
            <span className="block text-[10px] font-normal text-muted-strong">
              discovery {formatDateTime(nextDue(lastDiscoveryAt, cfg.discoveryIntervalMin))} ·
              comments {formatDateTime(nextDue(lastCommentsAt, cfg.commentsIntervalMin))}
            </span>
          </Stat>
          <Stat label="Quiet hours">
            {cfg.quietHoursEnabled ? (
              <span className={quiet ? "text-accent" : "text-positive"}>
                {quiet ? "PAUSED now (overnight)" : "Enabled"}
              </span>
            ) : (
              "Disabled"
            )}
            <span className="block text-[10px] font-normal text-muted-strong">
              {String(cfg.quietStartHour).padStart(2, "0")}:00–
              {String(cfg.quietEndHour).padStart(2, "0")}:00 {cfg.quietTimezone} · manual force
              refresh stays available (cost warning shown)
              {lastQuietSkip && (
                <>
                  {" "}· last overnight skip <TimeAgo iso={lastQuietSkip.startedAt} />
                </>
              )}
            </span>
          </Stat>
          <Stat label="Last by type">
            {lastFullAt ? (
              <>
                full <TimeAgo iso={lastFullAt} />
              </>
            ) : (
              "full —"
            )}
            <span className="block text-[10px] font-normal text-muted-strong">
              discovery {lastDiscoveryAt ? <TimeAgo iso={lastDiscoveryAt} /> : "—"} · comment detail{" "}
              {lastCommentsAt ? <TimeAgo iso={lastCommentsAt} /> : "—"}
            </span>
          </Stat>
          <Stat label="Busiest source today">
            {busiest ? `${PLATFORM_LABEL[busiest[0]] ?? busiest[0]} · ${busiest[1]} runs` : "—"}
            <span className="block text-[10px] font-normal text-muted-strong">
              Most actor runs today (cost proxy) · per-run $ in the Apify console
            </span>
          </Stat>
          <Stat label="Skipped refreshes (recent)">
            {skipTotal} skipped
            <span className="block text-[10px] font-normal text-muted-strong">
              {skipSummary || "none in the recent window"}
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
            The endpoint answers 202 immediately and refreshes in the background. cron-job.org pings every 30 minutes (06:00–23:59 ET); the app&apos;s cost policy decides whether a full refresh, discovery, or comments are due — or skips cleanly. Secrets are never displayed here. Overlaps are
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
