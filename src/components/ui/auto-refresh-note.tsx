// Public replacement for the old refresh button: viewers don't trigger
// anything — data updates on a schedule and everyone sees the same saved view.
//
// Honest by construction: the cadence claim renders only while the
// verified scheduler metadata says so AND the data is actually fresh. When
// the last success ages past the thresholds the note degrades to a delayed
// status instead of repeating a cadence promise the data contradicts.

import { AlertTriangle, Moon, RefreshCw } from "lucide-react";
import { getStore } from "@/lib/store";
import { TimeAgo } from "@/components/ui/time-ago";
import { AnimatedText } from "@/components/ui/animated-text";
import {
  REFRESH_DELAYED_AFTER_MIN,
  SCHEDULER,
  SCHEDULER_DELAYED_AFTER_MIN,
} from "@/lib/scheduler";
import { getRefreshPolicyConfig, isQuietHours } from "@/lib/refresh-policy";

export async function AutoRefreshNote({
  variant = "pill",
}: {
  /** "pill" = bordered chip (interior pages). "inline" = quiet hero text row
   * with a live pulse dot — same honesty logic, calmer rendering. */
  variant?: "pill" | "inline";
} = {}) {
  let lastSuccessAt: string | null = null;
  try {
    const runs = await getStore().listRefreshRuns(15);
    const lastSuccess = runs.find((r) => r.status === "success" || r.status === "partial");
    lastSuccessAt = lastSuccess ? (lastSuccess.finishedAt ?? lastSuccess.startedAt) : null;
  } catch {
    // Status note must never take the page down.
  }

  // Server component rendered per-request — freshness vs. wall clock is the point.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const ageMin = lastSuccessAt ? (now - new Date(lastSuccessAt).getTime()) / 60_000 : null;
  const delayed = ageMin !== null && ageMin > REFRESH_DELAYED_AFTER_MIN;
  const veryDelayed = ageMin !== null && ageMin > SCHEDULER_DELAYED_AFTER_MIN;

  // Overnight pause is intentional, never a warning state.
  const quiet = isQuietHours(new Date(now), getRefreshPolicyConfig());
  if (quiet) {
    const body = (
      <>
        <AnimatedText text="Refresh paused overnight · resumes at 6:00 AM ET" />
        {lastSuccessAt && (
          <span className="text-muted-strong">
            {" "}· Last successful refresh <TimeAgo iso={lastSuccessAt} />
          </span>
        )}
      </>
    );
    if (variant === "inline") {
      return (
        <span
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
          title="Scheduled refreshes pause from 12:00 AM to 6:00 AM Eastern to save collection credits. The dashboard keeps showing the latest saved data."
        >
          <Moon size={12} className="text-muted-strong" aria-hidden />
          {body}
        </span>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted whitespace-nowrap"
        title="Scheduled refreshes pause from 12:00 AM to 6:00 AM Eastern to save collection credits. The dashboard keeps showing the latest saved data."
      >
        <Moon size={12} className="text-muted-strong" aria-hidden />
        {body}
      </span>
    );
  }

  if (SCHEDULER.verified && !delayed) {
    if (variant === "inline") {
      return (
        <span
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
          title={`Campaign data refreshes automatically about every ${SCHEDULER.cadenceMinutes} minutes during active hours. All viewers see the same saved data.`}
        >
          <span className="flex items-center gap-2">
            <span className="pulse-dot" aria-hidden />
            <AnimatedText text={`Auto-refreshing every ${SCHEDULER.cadenceMinutes} minutes`} />
          </span>
          {lastSuccessAt && (
            <span className="text-muted-strong">
              · Updated <TimeAgo iso={lastSuccessAt} />
            </span>
          )}
        </span>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted whitespace-nowrap"
        title={`Campaign data refreshes automatically about every ${SCHEDULER.cadenceMinutes} minutes during active hours. All viewers see the same saved data.`}
      >
        <RefreshCw size={12} className="text-muted-strong" aria-hidden />
        <AnimatedText text={`Auto-refreshes every ${SCHEDULER.cadenceMinutes} minutes`} />
        {lastSuccessAt && (
          <span className="text-muted-strong">
            · Last successful refresh <TimeAgo iso={lastSuccessAt} />
          </span>
        )}
      </span>
    );
  }

  if (variant === "inline") {
    return (
      <span
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-warning/90"
        title="The scheduled refresh is running behind. The dashboard shows the latest saved data."
      >
        <AlertTriangle size={12} aria-hidden />
        <AnimatedText
          text={
            veryDelayed || !SCHEDULER.verified
              ? "Scheduler may be delayed"
              : "Refresh delayed, latest data shown"
          }
        />
        {lastSuccessAt && (
          <span className="text-muted-strong">
            · Last successful refresh <TimeAgo iso={lastSuccessAt} />
          </span>
        )}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted whitespace-nowrap"
      title="The scheduled refresh is running behind. The dashboard shows the latest saved data."
    >
      <AlertTriangle size={12} className="text-warning" aria-hidden />
      <AnimatedText
        text={veryDelayed || !SCHEDULER.verified ? "Scheduler may be delayed" : "Refresh delayed, latest data shown"}
      />
      {lastSuccessAt && (
        <span className="text-muted-strong">
          · Last successful refresh <TimeAgo iso={lastSuccessAt} />
        </span>
      )}
    </span>
  );
}
