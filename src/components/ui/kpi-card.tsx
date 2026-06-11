// Primary KPI card. Always shows the last-updated time; renders an explicit
// "Unavailable" state instead of fake zeros.

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
}) {
  const unavailable = value === null;
  return (
    <Card className="px-4 py-3.5">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      {unavailable ? (
        <>
          <div className="mt-1 text-lg font-semibold text-muted-strong">Unavailable</div>
          {unavailableReason && (
            <div className="mt-0.5 text-[11px] text-muted-strong">{unavailableReason}</div>
          )}
        </>
      ) : (
        <>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="tabular text-2xl font-semibold tracking-tight" style={accent ? { color: accent } : undefined}>
              {value}
            </span>
            {delta !== undefined && <DeltaTag value={delta} label={deltaLabel} />}
          </div>
        </>
      )}
      {updatedAt !== undefined && (
        <div className="mt-1.5 text-[10px] text-muted-strong">
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
