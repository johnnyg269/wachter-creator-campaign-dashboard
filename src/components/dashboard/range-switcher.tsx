// Segmented time-range switcher for the dashboard trend chart. Pure links so
// the page stays fully server-rendered.

import Link from "next/link";
import clsx from "clsx";
import type { TimeRange } from "@/lib/queries";

const RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export function RangeSwitcher({
  active,
  basePath = "/",
  campaign,
}: {
  active: TimeRange;
  /** Page the range links point at — "/" for the dashboard, "/videos" etc. */
  basePath?: string;
  /** Preserve the current ?campaign= filter when switching range. */
  campaign?: string;
}) {
  const campaignQs = campaign && campaign !== "all" ? `&campaign=${campaign}` : "";
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5"
      role="group"
      aria-label="Time range"
    >
      {RANGES.map((r) => (
        <Link
          key={r.value}
          href={`${basePath}?range=${r.value}${campaignQs}`}
          aria-current={r.value === active ? "page" : undefined}
          className={clsx(
            "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            r.value === active
              ? "bg-[var(--accent-soft)] text-foreground"
              : "text-muted hover:text-foreground hover:bg-surface-hover",
          )}
        >
          {r.label}
        </Link>
      ))}
    </div>
  );
}
