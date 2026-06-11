"use client";

// Interactive alerts board: client-side severity/platform/type filtering,
// "Mark reviewed" actions, and a collapsed history of reviewed alerts.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import {
  BellOff,
  Check,
  ChevronRight,
  ExternalLink,
  Lightbulb,
  Loader2,
  SearchX,
} from "lucide-react";
import type { Alert, AlertSeverity, AlertType, Platform, Video } from "@/lib/types";
import { PLATFORM_LABELS, PLATFORMS } from "@/lib/types";
import { truncate } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { SeverityBadge } from "@/components/ui/status";
import { PlatformBadge } from "@/components/ui/platform";
import { TimeAgo } from "@/components/ui/time-ago";
import { EmptyState } from "@/components/ui/empty-state";

type AlertWithVideo = Alert & { video: Video | null };

const SEVERITY_ORDER: AlertSeverity[] = ["critical", "warning", "opportunity", "info"];

const SEVERITY_BORDER: Record<AlertSeverity, string> = {
  critical: "border-l-negative",
  warning: "border-l-warning",
  opportunity: "border-l-positive",
  info: "border-l-accent",
};

const SEVERITY_PILL_ACTIVE: Record<AlertSeverity, string> = {
  critical: "border-negative/40 bg-[rgba(248,113,113,0.12)] text-negative",
  warning: "border-warning/40 bg-[rgba(251,191,36,0.1)] text-warning",
  opportunity: "border-positive/40 bg-[rgba(52,211,153,0.1)] text-positive",
  info: "border-accent/40 bg-[rgba(59,130,246,0.1)] text-accent",
};

/** "negative_comment_spike" → "Negative comment spike" */
function humanizeType(type: AlertType): string {
  const s = type.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function videoLinkLabel(video: Video): string {
  return truncate(video.title ?? video.caption ?? "View video", 60);
}

export function AlertsBoard({
  open,
  reviewed,
}: {
  open: AlertWithVideo[];
  reviewed: AlertWithVideo[];
}) {
  const router = useRouter();
  const [severity, setSeverity] = useState<AlertSeverity | "all">("all");
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [type, setType] = useState<AlertType | "all">("all");
  const [showReviewed, setShowReviewed] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const all = useMemo(() => [...open, ...reviewed], [open, reviewed]);

  const platformOptions = useMemo(
    () => PLATFORMS.filter((p) => all.some((a) => a.platform === p)),
    [all],
  );
  const typeOptions = useMemo(() => {
    const present = new Set<AlertType>(all.map((a) => a.type));
    return [...present].sort((a, b) => humanizeType(a).localeCompare(humanizeType(b)));
  }, [all]);

  const matchesFilters = (a: AlertWithVideo) =>
    (severity === "all" || a.severity === severity) &&
    (platform === "all" || a.platform === platform) &&
    (type === "all" || a.type === type);

  const openFiltered = useMemo(
    () =>
      open
        .filter(matchesFilters)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, severity, platform, type],
  );
  const reviewedFiltered = useMemo(
    () =>
      reviewed
        .filter(matchesFilters)
        .sort((a, b) => (b.reviewedAt ?? b.createdAt).localeCompare(a.reviewedAt ?? a.createdAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reviewed, severity, platform, type],
  );

  const openCountBySeverity = useMemo(() => {
    const counts: Record<AlertSeverity, number> = { critical: 0, warning: 0, opportunity: 0, info: 0 };
    for (const a of open) counts[a.severity]++;
    return counts;
  }, [open]);

  const filtersActive = severity !== "all" || platform !== "all" || type !== "all";

  function clearFilters() {
    setSeverity("all");
    setPlatform("all");
    setType("all");
  }

  async function markReviewed(id: string) {
    setPendingId(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/alerts/${id}/review`, { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setActionError(data.error ?? "Could not mark alert as reviewed");
      } else {
        router.refresh();
      }
    } catch {
      setActionError("Request failed — check your connection and try again");
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by severity">
            <SeverityPill
              label="All"
              active={severity === "all"}
              count={open.length}
              onClick={() => setSeverity("all")}
            />
            {SEVERITY_ORDER.map((s) => (
              <SeverityPill
                key={s}
                label={s.charAt(0).toUpperCase() + s.slice(1)}
                active={severity === s}
                activeClass={SEVERITY_PILL_ACTIVE[s]}
                count={openCountBySeverity[s]}
                onClick={() => setSeverity(severity === s ? "all" : s)}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <select
              aria-label="Filter by platform"
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform | "all")}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-foreground transition-colors hover:border-border-strong focus:border-border-strong focus:outline-none"
            >
              <option value="all">All platforms</option>
              {platformOptions.map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABELS[p]}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by alert type"
              value={type}
              onChange={(e) => setType(e.target.value as AlertType | "all")}
              className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-foreground transition-colors hover:border-border-strong focus:border-border-strong focus:outline-none"
            >
              <option value="all">All types</option>
              {typeOptions.map((t) => (
                <option key={t} value={t}>
                  {humanizeType(t)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-strong">
          <span className="font-medium text-negative">Critical</span> needs action now ·{" "}
          <span className="font-medium text-warning">Warning</span> something broke or dipped ·{" "}
          <span className="font-medium text-positive">Opportunity</span> momentum worth amplifying ·{" "}
          <span className="font-medium text-accent">Info</span> routine campaign activity
        </p>
      </div>

      {actionError && (
        <div className="rounded-lg border border-negative/30 bg-[rgba(248,113,113,0.08)] px-3 py-2 text-xs text-negative">
          {actionError}
        </div>
      )}

      {/* Open alerts */}
      {open.length === 0 ? (
        <EmptyState
          icon={<BellOff size={22} />}
          title="No open alerts"
          detail="Alerts appear when videos spike, comments need responses, or a refresh fails."
        />
      ) : openFiltered.length === 0 ? (
        <EmptyState
          icon={<SearchX size={22} />}
          title="No open alerts match your filters"
          detail={`${open.length} open ${open.length === 1 ? "alert is" : "alerts are"} hidden by the current filters.`}
          action={
            <button
              onClick={clearFilters}
              className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors hover:border-border-strong hover:bg-surface-hover"
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {openFiltered.map((alert) => (
            <OpenAlertCard
              key={alert.id}
              alert={alert}
              pending={pendingId === alert.id}
              onReview={() => markReviewed(alert.id)}
            />
          ))}
        </div>
      )}

      {/* Reviewed history (collapsed by default) */}
      <section className="mt-4 border-t border-border pt-4">
        <button
          onClick={() => setShowReviewed((v) => !v)}
          aria-expanded={showReviewed}
          className="flex items-center gap-2 text-xs font-medium text-muted transition-colors hover:text-foreground"
        >
          <ChevronRight
            size={14}
            className={clsx("transition-transform", showReviewed && "rotate-90")}
          />
          Reviewed
          <span className="tabular rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-muted-strong">
            {filtersActive ? `${reviewedFiltered.length} of ${reviewed.length}` : reviewed.length}
          </span>
        </button>
        {showReviewed && (
          <div className="mt-3 flex flex-col gap-2">
            {reviewed.length === 0 ? (
              <p className="px-1 text-xs text-muted-strong">
                Nothing reviewed yet — alerts you mark reviewed will appear here.
              </p>
            ) : reviewedFiltered.length === 0 ? (
              <p className="px-1 text-xs text-muted-strong">
                No reviewed alerts match the current filters.
              </p>
            ) : (
              reviewedFiltered.map((alert) => <ReviewedAlertRow key={alert.id} alert={alert} />)
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function SeverityPill({
  label,
  count,
  active,
  activeClass,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  activeClass?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? (activeClass ?? "border-border-strong bg-surface-hover text-foreground")
          : "border-border bg-surface text-muted hover:border-border-strong hover:text-foreground",
      )}
    >
      {label}
      {count > 0 && <span className="tabular text-[10px] opacity-75">{count}</span>}
    </button>
  );
}

function OpenAlertCard({
  alert,
  pending,
  onReview,
}: {
  alert: AlertWithVideo;
  pending: boolean;
  onReview: () => void;
}) {
  return (
    <Card className={clsx("border-l-[3px]", SEVERITY_BORDER[alert.severity])}>
      <div className="flex flex-col gap-2.5 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={alert.severity} />
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">
            {humanizeType(alert.type)}
          </span>
          {alert.platform && <PlatformBadge platform={alert.platform} size="sm" />}
          <span className="ml-auto text-[11px] text-muted-strong">
            <TimeAgo iso={alert.createdAt} />
          </span>
        </div>

        <div>
          <h3 className="text-sm font-semibold tracking-tight">{alert.title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{alert.message}</p>
        </div>

        {alert.suggestedAction && (
          <div className="flex items-start gap-2.5 rounded-lg border border-accent/20 bg-[var(--accent-soft)] px-3 py-2.5">
            <Lightbulb size={14} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-accent">
                Suggested action
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-foreground/90">
                {alert.suggestedAction}
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          {alert.video ? (
            <a
              href={alert.video.originalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted transition-colors hover:text-accent"
            >
              <ExternalLink size={12} className="shrink-0" />
              <span className="truncate">{videoLinkLabel(alert.video)}</span>
            </a>
          ) : (
            <span />
          )}
          <button
            onClick={onReview}
            disabled={pending}
            className={clsx(
              "inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors",
              pending
                ? "cursor-wait text-muted"
                : "hover:border-border-strong hover:bg-surface-hover",
            )}
          >
            {pending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Check size={13} className="text-positive" />
            )}
            {pending ? "Marking…" : "Mark reviewed"}
          </button>
        </div>
      </div>
    </Card>
  );
}

function ReviewedAlertRow({ alert }: { alert: AlertWithVideo }) {
  return (
    <div className="rounded-xl border border-border bg-surface/60 px-4 py-3 opacity-80">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={alert.severity} />
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">
          {humanizeType(alert.type)}
        </span>
        {alert.platform && <PlatformBadge platform={alert.platform} size="sm" />}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted">
          {alert.title}
        </span>
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-strong">
          <Check size={11} />
          Reviewed <TimeAgo iso={alert.reviewedAt} />
        </span>
      </div>
    </div>
  );
}
