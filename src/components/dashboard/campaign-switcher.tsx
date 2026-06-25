// Segmented campaign filter (All / Bootcamp / MTL). Pure links so pages stay
// fully server-rendered; preserves the current ?range= so it composes with the
// time-range switcher.

import Link from "next/link";
import clsx from "clsx";
import type { CampaignFilter } from "@/lib/campaigns";

const OPTIONS: Array<{ value: CampaignFilter; label: string }> = [
  { value: "all", label: "All Campaigns" },
  { value: "mtl", label: "MTL" },
  { value: "bootcamp", label: "Bootcamp" },
];

export function CampaignSwitcher({
  active,
  basePath = "/",
  range,
}: {
  active: CampaignFilter;
  basePath?: string;
  /** Preserve the current time range in the link, if the page uses one. */
  range?: string;
}) {
  const href = (value: CampaignFilter) =>
    `${basePath}?campaign=${value}${range ? `&range=${range}` : ""}`;
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5"
      role="group"
      aria-label="Campaign"
    >
      {OPTIONS.map((o) => (
        <Link
          key={o.value}
          href={href(o.value)}
          aria-current={o.value === active ? "page" : undefined}
          className={clsx(
            "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            o.value === active
              ? "bg-[var(--accent-soft)] text-foreground"
              : "text-muted hover:text-foreground hover:bg-surface-hover",
          )}
        >
          {o.label}
        </Link>
      ))}
    </div>
  );
}
