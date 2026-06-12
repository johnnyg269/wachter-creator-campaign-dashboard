// Primary KPI card. Always shows the last-updated time; renders an explicit
// "Unavailable" state instead of fake zeros. Icon + context line keep each
// number self-explanatory without a legend.

import type { ReactNode } from "react";
import { Card } from "./card";
import { DeltaTag } from "./delta";
import { TimeAgo } from "./time-ago";

export function KpiCard({
  label,
  value,
  delta,
  deltaLabel,
  updatedAt,
  unavailableReason,
  accent,
  icon,
  context,
}: {
  label: string;
  /** Pre-formatted display value; pass null when unavailable. */
  value: string | null;
  delta?: number | null;
  deltaLabel?: string;
  updatedAt?: string | null;
  /** When set, the card renders the unavailable state with this reason. */
  unavailableReason?: string | null;
  accent?: string;
  /** Small lucide icon rendered beside the label. */
  icon?: ReactNode;
  /** One short supporting line under the number. */
  context?: string;
}) {
  const unavailable = value === null;
  return (
    <Card className="px-4 py-4">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-strong">
        {icon && (
          <span aria-hidden className="text-muted-strong/80 [&>svg]:h-3 [&>svg]:w-3">
            {icon}
          </span>
        )}
        {label}
      </div>
      {unavailable ? (
        <>
          <div className="mt-1.5 text-lg font-semibold text-muted-strong">Unavailable</div>
          {unavailableReason && (
            <div className="mt-0.5 text-[11px] text-muted-strong">{unavailableReason}</div>
          )}
        </>
      ) : (
        <>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span
              className="tabular-nums text-[26px] font-bold leading-none tracking-tight"
              style={accent ? { color: accent } : undefined}
            >
              {value}
            </span>
            {delta !== undefined && <DeltaTag value={delta} label={deltaLabel} />}
          </div>
          {context && <div className="mt-1 truncate text-[11px] text-muted">{context}</div>}
        </>
      )}
      {updatedAt !== undefined && (
        <div className="mt-2 text-[10px] text-muted-strong/80">
          {updatedAt ? (
            <>
              Updated <TimeAgo iso={updatedAt} />
            </>
          ) : (
            "Awaiting first refresh"
          )}
        </div>
      )}
    </Card>
  );
}
