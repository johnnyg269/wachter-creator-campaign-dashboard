import clsx from "clsx";
import { formatDelta } from "@/lib/format";

/** Small +N / −N tag. Null → "—" in muted (unavailable, not zero). */
export function DeltaTag({
  value,
  label,
  className,
}: {
  value: number | null | undefined;
  label?: string;
  className?: string;
}) {
  if (value === null || value === undefined) {
    return (
      <span className={clsx("text-[11px] text-muted-strong", className)} title="Not enough data yet">
        — {label}
      </span>
    );
  }
  return (
    <span
      className={clsx(
        "tabular text-[11px] font-medium",
        value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-muted",
        className,
      )}
    >
      {formatDelta(value)}
      {label ? ` ${label}` : ""}
    </span>
  );
}
