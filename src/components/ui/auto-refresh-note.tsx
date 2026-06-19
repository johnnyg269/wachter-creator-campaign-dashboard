// Public refresh status. Viewers never trigger anything — data updates on a
// schedule and everyone sees the same saved view. The wording is operational
// and honest, never vague "confidence" language:
//   fresh      → "Live tracking active · Updated 12m ago · Next refresh in 3m"
//   due        → "Live tracking active · Updated 17m ago · Refresh due now"
//   delayed    → "Refresh delayed · Last successful pull 34m ago"
//   overnight  → "Refresh paused overnight · resumes 7:00 AM ET"
// "Next refresh" is derived from the cadence + age at render (an estimate), so a
// 17-minutes-old reading on a 15-minute cadence reads as "due now", not broken.

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

type Tone = "live" | "delayed" | "quiet";

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
  const cfg = getRefreshPolicyConfig();
  const cadence = SCHEDULER.cadenceMinutes;
  const ageMin = lastSuccessAt ? (now - new Date(lastSuccessAt).getTime()) / 60_000 : null;
  const delayed = ageMin !== null && ageMin > REFRESH_DELAYED_AFTER_MIN;
  const veryDelayed = ageMin !== null && ageMin > SCHEDULER_DELAYED_AFTER_MIN;
  const nextInMin = ageMin === null ? null : Math.max(0, Math.ceil(cadence - ageMin));
  const quiet = isQuietHours(new Date(now), cfg);
  const resumeHour = `${cfg.quietEndHour === 0 ? 12 : cfg.quietEndHour > 12 ? cfg.quietEndHour - 12 : cfg.quietEndHour}:00 ${cfg.quietEndHour < 12 ? "AM" : "PM"} ET`;

  // Decide the operational state + copy.
  let tone: Tone;
  let label: string;
  let title: string;
  if (quiet) {
    tone = "quiet";
    label = `Refresh paused overnight · resumes ${resumeHour}`;
    title = `Scheduled refreshes pause overnight to save collection credits. The dashboard keeps showing the latest saved data.`;
  } else if (delayed || !SCHEDULER.verified) {
    tone = "delayed";
    label = veryDelayed || !SCHEDULER.verified ? "Scheduler may be delayed" : "Refresh delayed";
    title = "The scheduled refresh is running behind. The dashboard shows the latest saved data.";
  } else {
    tone = "live";
    label = "Live tracking active";
    title = `Campaign data refreshes automatically about every ${cadence} minutes during active hours. All viewers see the same saved data.`;
  }

  // The trailing "· Updated Xm ago · Next refresh …" detail line.
  const detail = lastSuccessAt ? (
    <span className="text-muted-strong">
      {tone === "delayed" ? (
        <>
          {" "}· Last successful pull <TimeAgo iso={lastSuccessAt} />
        </>
      ) : tone === "quiet" ? (
        <>
          {" "}· Last successful refresh <TimeAgo iso={lastSuccessAt} />
        </>
      ) : (
        <>
          {" "}· Updated <TimeAgo iso={lastSuccessAt} /> ·{" "}
          {nextInMin && nextInMin > 0 ? `Next refresh in ${nextInMin}m` : "Refresh due now"}
        </>
      )}
    </span>
  ) : null;

  const Icon = tone === "quiet" ? Moon : tone === "delayed" ? AlertTriangle : RefreshCw;
  const iconCls = tone === "delayed" ? "text-warning" : "text-muted-strong";

  if (variant === "inline") {
    return (
      <span
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${tone === "delayed" ? "text-warning/90" : "text-muted"}`}
        title={title}
      >
        <span className="flex items-center gap-2">
          {tone === "live" ? (
            <span className="pulse-dot" aria-hidden />
          ) : (
            <Icon size={12} className={iconCls} aria-hidden />
          )}
          <AnimatedText text={label} />
        </span>
        {detail}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs whitespace-nowrap ${tone === "delayed" ? "text-warning/90" : "text-muted"}`}
      title={title}
    >
      <Icon size={12} className={iconCls} aria-hidden />
      <AnimatedText text={label} />
      {detail}
    </span>
  );
}
