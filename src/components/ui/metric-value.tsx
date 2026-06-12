// Honest metric display — no bare dashes for important metrics:
//   confirmed fresh  → "1.4K"
//   confirmed stale  → "1.4K ⏱" (title: "last confirmed X ago")
//   never refreshed  → "Pending"
//   refreshed, never reported → "Not exposed"

import clsx from "clsx";
import type { ConfirmedValue } from "@/lib/metrics";
import { formatCompact, timeAgo } from "@/lib/format";
import { BadgeCheck, History } from "lucide-react";

export function MetricValue({
  confirmed,
  hasAnySnapshot,
  className,
}: {
  confirmed: ConfirmedValue | null;
  /** Whether ANY snapshot exists for the video (pending vs not-exposed). */
  hasAnySnapshot: boolean;
  className?: string;
}) {
  if (confirmed) {
    return (
      <span
        className={clsx("tabular inline-flex items-center gap-1", className)}
        title={
          confirmed.manual
            ? `Manually verified ${timeAgo(confirmed.at)} by admin`
            : confirmed.stale
              ? `Last confirmed ${timeAgo(confirmed.at)} — the source didn't report this metric on the latest refresh`
              : undefined
        }
      >
        {formatCompact(confirmed.value)}
        {confirmed.manual && (
          <BadgeCheck size={10} className="text-accent" aria-label="Manually verified" />
        )}
        {!confirmed.manual && confirmed.stale && (
          <History size={10} className="text-muted-strong" aria-label="Last-confirmed value" />
        )}
      </span>
    );
  }
  return (
    <span
      className={clsx("text-[10px] font-medium uppercase tracking-wide text-muted-strong", className)}
      title={
        hasAnySnapshot
          ? "The source does not expose this metric for this video (all fallbacks tried)"
          : "Awaiting first refresh"
      }
    >
      {hasAnySnapshot ? "Not exposed" : "Pending"}
    </span>
  );
}
