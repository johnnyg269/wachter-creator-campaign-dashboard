// Source-status pill — the single way data provenance is shown in the UI.

import clsx from "clsx";
import type { SourceStatus } from "@/lib/types";
import { SOURCE_STATUS_LABELS } from "@/lib/types";

const STYLES: Record<SourceStatus, { dot: string; text: string }> = {
  live: { dot: "bg-positive", text: "text-positive" },
  demo: { dot: "bg-warning", text: "text-warning" },
  waiting: { dot: "bg-accent", text: "text-accent" },
  token_connected: { dot: "bg-accent", text: "text-accent" },
  needs_api_key: { dot: "bg-warning", text: "text-warning" },
  actor_not_configured: { dot: "bg-warning", text: "text-warning" },
  needs_apify_token: { dot: "bg-warning", text: "text-warning" },
  needs_auth: { dot: "bg-warning", text: "text-warning" },
  manual_required: { dot: "bg-muted-strong", text: "text-muted" },
  refresh_failed: { dot: "bg-negative", text: "text-negative" },
};

export function StatusPill({
  status,
  detail,
  size = "md",
}: {
  status: SourceStatus;
  detail?: string | null;
  size?: "sm" | "md";
}) {
  const s = STYLES[status];
  return (
    <span
      title={detail ?? undefined}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface font-medium whitespace-nowrap",
        s.text,
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]",
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", s.dot, status === "live" && "animate-pulse")} />
      {SOURCE_STATUS_LABELS[status]}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: "info" | "opportunity" | "warning" | "critical" }) {
  const map = {
    info: "text-accent bg-[rgba(59,130,246,0.1)]",
    opportunity: "text-positive bg-[rgba(52,211,153,0.1)]",
    warning: "text-warning bg-[rgba(251,191,36,0.1)]",
    critical: "text-negative bg-[rgba(248,113,113,0.12)]",
  } as const;
  return (
    <span className={clsx("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", map[severity])}>
      {severity}
    </span>
  );
}
