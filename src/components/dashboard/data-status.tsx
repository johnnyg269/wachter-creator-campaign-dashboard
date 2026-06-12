// Collapsible "Data status" drawer — the operational truth, moved to the
// bottom of the public dashboard so the top of the page leads with campaign
// performance instead of system diagnostics. Honesty unchanged: everything
// that used to live in the hero chips is still here, one click away.

import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import type { HealthSummary } from "@/lib/queries";
import type { SourceCapability } from "@/lib/queries";
import { SourceStatusPanel } from "@/components/dashboard/source-status";
import { SCHEDULER } from "@/lib/scheduler";

export function DataStatusDrawer({
  health,
  capabilities,
  liveCount,
  anyFailed,
  hasGaps,
  delayed,
}: {
  health: HealthSummary;
  capabilities: SourceCapability[];
  liveCount: number;
  anyFailed: boolean;
  hasGaps: boolean;
  delayed: boolean;
}) {
  const total = health.platforms.length;
  const tone = anyFailed ? "text-negative" : liveCount === total ? "text-positive" : "text-warning";
  const summaryBits = [
    `${liveCount}/${total} platforms connected`,
    `Updated every ${SCHEDULER.cadenceMinutes} minutes`,
    ...(hasGaps ? ["Some optional metrics unavailable"] : []),
    ...(delayed && !anyFailed ? ["Some platform data may be delayed"] : []),
    ...(anyFailed ? ["A platform refresh recently failed"] : []),
  ];

  return (
    <details className="group rounded-xl border border-border bg-surface/60">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 text-xs marker:content-none [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-semibold">
          <span
            className={clsx(
              "h-2 w-2 rounded-full",
              anyFailed ? "bg-negative" : liveCount === total ? "bg-positive" : "bg-warning",
            )}
            aria-hidden
          />
          Data status
        </span>
        <span className={clsx("flex flex-wrap items-center gap-x-2 text-muted", tone === "text-negative" && "text-negative")}>
          {summaryBits.map((bit, i) => (
            <span key={bit} className="flex items-center gap-2">
              {i > 0 && <span aria-hidden className="text-muted-strong">·</span>}
              {bit}
            </span>
          ))}
        </span>
        <ChevronDown
          size={14}
          aria-hidden
          className="ml-auto shrink-0 text-muted-strong transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border px-4 py-3">
        <SourceStatusPanel
          platforms={health.platforms.map((p) => ({
            platform: p.platform,
            sourceStatus: p.sourceStatus,
            statusDetail:
              p.sourceStatus === "live" || p.sourceStatus === "waiting"
                ? null
                : "Not connected — configure in Admin",
            lastSuccessfulRefreshAt: p.lastSuccessfulRefreshAt,
            supportsComments: p.supportsComments,
            supportsDiscovery: p.supportsDiscovery,
            sourceLabel:
              p.providerType === "youtube_api"
                ? "Official YouTube API"
                : p.providerType === "mock"
                  ? "Demo data"
                  : p.providerType === "manual"
                    ? "Manual entry"
                    : "Automated collection",
          }))}
          capabilities={capabilities.map((c) =>
            c.live ? c : { ...c, summary: "Not connected — configure in Admin" },
          )}
        />
      </div>
    </details>
  );
}
