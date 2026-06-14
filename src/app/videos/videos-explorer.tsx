"use client";

// Phase 4 Videos command center — premium, read-only content performance view.
// Server fetches range-aware rows once; this component handles the summary
// strip, Growth Leaders, filtering/sorting, the card grid, and a read-only
// detail drawer. No mutations — the public Videos page never edits data.

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  ArrowDown,
  ArrowUp,
  Eye,
  Film,
  FilterX,
  Flame,
  Layers,
  MessagesSquare,
  Search,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import type { VideoRowData } from "@/lib/queries";
import type { Platform } from "@/lib/types";
import { PLATFORMS, PLATFORM_LABELS } from "@/lib/types";
import { formatCompact, formatDate, formatDelta, formatPct, truncate } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { DeltaTag } from "@/components/ui/delta";
import { EmptyState } from "@/components/ui/empty-state";
import { MetricValue } from "@/components/ui/metric-value";
import { PLATFORM_COLORS, PLATFORM_HEX, PlatformBadge } from "@/components/ui/platform";
import { StatusPill } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/time-ago";
import { VideoThumb } from "@/components/ui/video-thumb";
import { Sparkline } from "@/components/charts/sparkline";

type SortKey = "growth" | "views" | "engagements" | "engagementRate" | "comments" | "newest" | "updated";
const SORT_LABELS: Record<SortKey, string> = {
  growth: "Growth",
  views: "Total views",
  engagements: "Engagements",
  engagementRate: "Engagement rate",
  comments: "Comments",
  newest: "Newest",
  updated: "Recently updated",
};

type StatusFilter =
  | "all"
  | "surging"
  | "new"
  | "needs-response"
  | "verified"
  | "no-thumbnail"
  | "awaiting-views";

const NEW_WINDOW_MS = 48 * 60 * 60 * 1000;

function postedAtMs(r: VideoRowData): number | null {
  const iso = r.video.publishedAt ?? r.video.firstTrackedAt;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function isNew(r: VideoRowData, now: number): boolean {
  const t = postedAtMs(r);
  return t !== null && now - t <= NEW_WINDOW_MS;
}

/** Surging = strong, recent, real growth relative to the video's own size. */
function isSurging(r: VideoRowData): boolean {
  const total = r.confirmed.views?.value ?? null;
  if (r.periodGrowth === null || r.periodGrowth <= 0) return false;
  if (r.periodGrowth >= 1000) return true;
  return total !== null && total > 0 && r.periodGrowth >= 0.15 * total && r.periodGrowth >= 200;
}

function sortValue(r: VideoRowData, key: SortKey): number | null {
  switch (key) {
    case "growth":
      return r.periodGrowth;
    case "views":
      return r.confirmed.views?.value ?? null;
    case "engagements":
      return r.engagements;
    case "engagementRate":
      return r.engagementRate;
    case "comments":
      return r.confirmed.comments?.value ?? null;
    case "newest":
      return postedAtMs(r);
    case "updated": {
      const t = r.video.lastRefreshedAt ? Date.parse(r.video.lastRefreshedAt) : NaN;
      return Number.isNaN(t) ? null : t;
    }
  }
}

const inputCls =
  "rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-strong focus:border-accent focus:outline-none";

// ── Status badges ──────────────────────────────────────────────────────────

function Badge({ tone, icon, children, title }: { tone: string; icon?: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
        tone,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

function StatusBadges({ r, now }: { r: VideoRowData; now: number }) {
  return (
    <>
      {isSurging(r) && (
        <Badge tone="text-positive bg-[rgba(52,211,153,0.12)]" icon={<Flame size={9} />} title="Strong recent view growth">
          Surging
        </Badge>
      )}
      {isNew(r, now) && (
        <Badge tone="text-accent bg-[var(--accent-soft)]" icon={<Sparkles size={9} />} title="Posted in the last 48 hours">
          New
        </Badge>
      )}
      {r.confirmed.views?.manual && (
        <Badge tone="text-positive bg-[rgba(52,211,153,0.1)]" title="View count verified by an admin">
          Verified
        </Badge>
      )}
      {r.audience.needsResponse > 0 && (
        <Badge tone="text-warning bg-[rgba(251,191,36,0.1)]" icon={<MessagesSquare size={9} />} title={`${r.audience.needsResponse} comment(s) may deserve a response`}>
          Needs response
        </Badge>
      )}
      {r.confirmed.views?.stale && (
        <Badge tone="text-muted bg-surface border border-border" title="Showing the count from a prior refresh">
          Stale
        </Badge>
      )}
      {!r.video.thumbnailUrl && (
        <Badge tone="text-muted-strong bg-surface border border-border" title="No thumbnail from the source — platform fallback shown">
          No thumbnail
        </Badge>
      )}
      {r.confirmed.views === null && (
        <Badge tone="text-muted-strong bg-surface border border-border" title="No confirmed view count captured yet">
          Awaiting views
        </Badge>
      )}
    </>
  );
}

// ── Summary strip ──────────────────────────────────────────────────────────

function SummaryStat({ label, value, sub, positive }: { label: string; value: string; sub?: string; positive?: boolean }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-strong">{label}</div>
      <div className={clsx("tabular-nums mt-1 text-xl font-bold leading-none tracking-tight", positive && "text-positive")}>
        {value}
      </div>
      {sub && <div className="mt-1 truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

// ── Growth leader card ─────────────────────────────────────────────────────

function GrowthLeaderCard({ r, rank, onOpen }: { r: VideoRowData; rank: number; onOpen: () => void }) {
  const title = r.video.title ?? r.video.caption ?? "Untitled video";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col gap-2.5 rounded-xl border border-border bg-surface/60 p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-hover/40"
    >
      <div className="flex items-start gap-2.5">
        <span
          className={clsx(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold tabular-nums",
            rank === 1 ? "bg-[var(--accent-soft)] text-accent ring-1 ring-accent/30" : "border border-border text-muted-strong",
          )}
        >
          {rank}
        </span>
        <VideoThumb src={r.video.thumbnailUrl} platform={r.video.platform} alt={title} className="h-12 w-9 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <PlatformBadge platform={r.video.platform} size="sm" />
            {r.episodeName && (
              <span className="truncate text-[10px] text-muted-strong">{truncate(r.episodeName, 18)}</span>
            )}
          </div>
          <div className="mt-1 line-clamp-2 text-xs font-medium leading-snug">{truncate(title, 80)}</div>
        </div>
      </div>
      <div className="flex items-end justify-between gap-2">
        <div>
          <div className="tabular-nums text-lg font-bold leading-none text-positive">
            {r.periodGrowth !== null ? formatDelta(r.periodGrowth) : "—"}
          </div>
          <div className="mt-0.5 text-[10px] text-muted-strong">
            views gained · {formatCompact(r.confirmed.views?.value ?? null)} total
          </div>
        </div>
        <Sparkline points={r.sparkline} color={PLATFORM_HEX[r.video.platform]} width={84} height={26} />
      </div>
      <div className="flex items-center gap-x-3 gap-y-1 text-[10px] text-muted-strong">
        <span className="tabular-nums">{formatCompact(r.engagements)} eng.</span>
        <span className="tabular-nums">{formatPct(r.engagementRate)} ER</span>
        <span className="tabular-nums">{formatCompact(r.confirmed.comments?.value ?? null)} comments</span>
      </div>
    </button>
  );
}

// ── Main video card ────────────────────────────────────────────────────────

function VideoCard({ r, now, onOpen }: { r: VideoRowData; now: number; onOpen: () => void }) {
  const v = r.video;
  const title = v.title ?? v.caption ?? "Untitled video";
  return (
    <Card className="flex flex-col gap-3 p-3.5 transition-transform hover:-translate-y-0.5">
      <button type="button" onClick={onOpen} className="group flex items-start gap-3 text-left">
        <VideoThumb src={v.thumbnailUrl} platform={v.platform} alt={title} className="h-20 w-14 shrink-0 rounded-lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <PlatformBadge platform={v.platform} size="sm" />
            {r.episodeName ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-muted whitespace-nowrap">
                <Layers size={9} />
                {truncate(r.episodeName, 22)}
              </span>
            ) : (
              <span className="text-[10px] text-muted-strong">Unassigned</span>
            )}
          </div>
          <div className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug transition-colors group-hover:text-accent">
            {title}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <StatusBadges r={r} now={now} />
          </div>
        </div>
      </button>

      <div className="grid grid-cols-4 gap-2 border-t border-border pt-2.5">
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-strong">Views</div>
          <div className="tabular-nums text-sm font-semibold">
            <MetricValue confirmed={r.confirmed.views} hasAnySnapshot={r.latest !== null} />
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-strong">Growth</div>
          <div className="text-sm font-semibold">
            <DeltaTag value={r.periodGrowth} />
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-strong">ER</div>
          <div className="tabular-nums text-sm font-semibold">{formatPct(r.engagementRate)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wide text-muted-strong">Comments</div>
          <div className="tabular-nums text-sm font-semibold">
            <MetricValue confirmed={r.confirmed.comments} hasAnySnapshot={r.latest !== null} />
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Sparkline points={r.sparkline} color={PLATFORM_HEX[v.platform]} width={120} height={26} />
        <span className="text-[10px] text-muted-strong whitespace-nowrap">{formatDate(v.publishedAt)}</span>
      </div>
    </Card>
  );
}

// ── Detail drawer (read-only) ──────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-[11px] text-muted-strong">{label}</span>
      <span className="tabular-nums text-right text-sm font-medium">{children}</span>
    </div>
  );
}

function DetailDrawer({ r, now, onClose }: { r: VideoRowData; now: number; onClose: () => void }) {
  const v = r.video;
  const title = v.title ?? v.caption ?? "Untitled video";
  const saves = r.latest?.saves ?? r.latest?.bookmarks ?? null;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Dialog a11y: Escape closes, focus moves into the drawer on open and is
  // restored on close, and background scroll is locked while open.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Details for ${truncate(title, 60)}`}>
      <button type="button" aria-label="Close details" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" />
      <div className="section-enter relative h-full w-full max-w-md overflow-y-auto border-l border-border bg-surface-raised shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-start gap-3">
            <VideoThumb src={v.thumbnailUrl} platform={v.platform} alt={title} className="h-24 w-16 shrink-0 rounded-lg" />
            <div className="min-w-0">
              <PlatformBadge platform={v.platform} size="sm" />
              <h2 className="mt-1.5 text-sm font-semibold leading-snug">{title}</h2>
              <a href={v.originalUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[11px] font-medium text-accent hover:underline">
                Open original post →
              </a>
            </div>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-lg border border-border p-1.5 text-muted transition-colors hover:text-foreground">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap gap-1.5">
            <StatusBadges r={r} now={now} />
          </div>

          <div className="rounded-xl border border-border bg-surface px-3 py-3">
            <div className="flex items-end justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-strong">Views gained · selected range</div>
                <div className="tabular-nums text-2xl font-bold leading-none text-positive">
                  {r.periodGrowth !== null ? formatDelta(r.periodGrowth) : "—"}
                  {r.periodGrowth !== null && !r.periodCoversFull && <span className="ml-1 text-[10px] text-muted-strong">*</span>}
                </div>
              </div>
              <Sparkline points={r.sparkline} color={PLATFORM_HEX[v.platform]} width={140} height={40} />
            </div>
            {r.periodGrowth !== null && !r.periodCoversFull && (
              <div className="mt-1.5 text-[10px] text-muted-strong">* Tracked for less than the full window — growth since first snapshot.</div>
            )}
          </div>

          <div className="rounded-xl border border-border">
            <div className="border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-muted-strong">Lifetime totals</div>
            <div className="divide-y divide-border px-3">
              <DetailRow label="Total views"><MetricValue confirmed={r.confirmed.views} hasAnySnapshot={r.latest !== null} /></DetailRow>
              <DetailRow label="Likes"><MetricValue confirmed={r.confirmed.likes} hasAnySnapshot={r.latest !== null} /></DetailRow>
              <DetailRow label="Comments"><MetricValue confirmed={r.confirmed.comments} hasAnySnapshot={r.latest !== null} /></DetailRow>
              <DetailRow label="Shares"><MetricValue confirmed={r.confirmed.shares} hasAnySnapshot={r.latest !== null} /></DetailRow>
              <DetailRow label="Saves">{formatCompact(saves)}</DetailRow>
              <DetailRow label="Engagement rate">{formatPct(r.engagementRate)}</DetailRow>
              <DetailRow label="Since first tracked"><DeltaTag value={r.growthSinceTracked} /></DetailRow>
            </div>
          </div>

          <div className="rounded-xl border border-border">
            <div className="border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-muted-strong">Audience signals</div>
            <div className="divide-y divide-border px-3">
              <DetailRow label="Comments captured">{formatCompact(r.audience.capturedComments)}</DetailRow>
              <DetailRow label="May need a response">
                <span className={r.audience.needsResponse > 0 ? "text-warning" : undefined}>{formatCompact(r.audience.needsResponse)}</span>
              </DetailRow>
              <DetailRow label="Top signal">{r.audience.topSignal ?? "—"}</DetailRow>
            </div>
          </div>

          <div className="rounded-xl border border-border">
            <div className="border-b border-border px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-muted-strong">Tracking</div>
            <div className="divide-y divide-border px-3">
              <DetailRow label="Episode">{r.episodeName ?? "Unassigned"}</DetailRow>
              <DetailRow label="Published">{formatDate(v.publishedAt)}</DetailRow>
              <DetailRow label="First tracked"><TimeAgo iso={v.firstTrackedAt} /></DetailRow>
              <DetailRow label="Last updated">{v.lastRefreshedAt ? <TimeAgo iso={v.lastRefreshedAt} /> : "never"}</DetailRow>
              <DetailRow label="Source"><StatusPill status={v.sourceStatus} detail={v.errorMessage} size="sm" /></DetailRow>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Explorer ───────────────────────────────────────────────────────────────

export function VideosExplorer({
  rows,
  rangeLabel,
  episodes,
}: {
  rows: VideoRowData[];
  rangeLabel: string;
  episodes: Array<{ id: string; name: string }>;
}) {
  // Wall-clock "now" for the New (<48h) badge; relative-time is the point.
  // eslint-disable-next-line react-hooks/purity
  const now = Date.now();
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [episode, setEpisode] = useState<string>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [hasComments, setHasComments] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("growth");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [openId, setOpenId] = useState<string | null>(null);

  const tracked = useMemo(() => rows.filter((r) => !r.video.hidden), [rows]);
  const hiddenCount = rows.length - tracked.length;

  // Summary strip — over all tracked videos (filter-independent).
  const summary = useMemo(() => {
    const gaining = tracked.filter((r) => (r.periodGrowth ?? 0) > 0).length;
    const fastest = [...tracked].sort((a, b) => (b.periodGrowth ?? -1) - (a.periodGrowth ?? -1))[0];
    const topEr = [...tracked].filter((r) => r.engagementRate !== null).sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0))[0];
    const needsResponse = tracked.reduce((s, r) => s + r.audience.needsResponse, 0);
    const missingThumb = tracked.filter((r) => !r.video.thumbnailUrl).length;
    return { gaining, fastest, topEr, needsResponse, missingThumb };
  }, [tracked]);

  const leaders = useMemo(
    () =>
      [...tracked]
        .filter((r) => (r.periodGrowth ?? 0) > 0)
        .sort((a, b) => (b.periodGrowth ?? 0) - (a.periodGrowth ?? 0))
        .slice(0, 6),
    [tracked],
  );

  const visible = showHidden ? rows : tracked;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visible.filter((r) => {
      const v = r.video;
      if (platform !== "all" && v.platform !== platform) return false;
      if (episode === "unassigned" ? v.episodeGroupId !== null : episode !== "all" && v.episodeGroupId !== episode) return false;
      if (hasComments && r.audience.capturedComments === 0) return false;
      if (status === "surging" && !isSurging(r)) return false;
      if (status === "new" && !isNew(r, now)) return false;
      if (status === "needs-response" && r.audience.needsResponse === 0) return false;
      if (status === "verified" && !r.confirmed.views?.manual) return false;
      if (status === "no-thumbnail" && v.thumbnailUrl) return false;
      if (status === "awaiting-views" && r.confirmed.views !== null) return false;
      if (q && !`${v.title ?? ""} ${v.caption ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [visible, platform, episode, status, hasComments, search, now]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [filtered, sortKey, sortDir]);

  const hasFilters = platform !== "all" || episode !== "all" || status !== "all" || hasComments || search.trim() !== "";
  function clearFilters() {
    setPlatform("all");
    setEpisode("all");
    setStatus("all");
    setHasComments(false);
    setSearch("");
  }

  const openRow = openId ? rows.find((r) => r.video.id === openId) ?? null : null;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Film size={24} />}
        title="No videos tracked yet"
        detail="Videos appear here after the first successful refresh. Connect a platform provider in Admin to start tracking."
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Summary strip */}
      <section className="section-enter grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-surface/70 sm:grid-cols-3 xl:grid-cols-5" aria-label="Video summary">
        <SummaryStat label="Videos tracked" value={formatCompact(tracked.length)} sub={hiddenCount > 0 ? `${hiddenCount} hidden` : "across all platforms"} />
        <SummaryStat label={`Gaining · ${rangeLabel}`} value={formatCompact(summary.gaining)} sub="climbing this period" positive={summary.gaining > 0} />
        <SummaryStat
          label="Fastest growing"
          value={summary.fastest && (summary.fastest.periodGrowth ?? 0) > 0 ? formatDelta(summary.fastest.periodGrowth) : "—"}
          sub={summary.fastest && (summary.fastest.periodGrowth ?? 0) > 0 ? truncate(summary.fastest.video.title ?? summary.fastest.video.caption ?? "Untitled", 24) : "needs two readings"}
          positive
        />
        <SummaryStat label="Highest ER" value={summary.topEr ? formatPct(summary.topEr.engagementRate) : "—"} sub={summary.topEr ? truncate(summary.topEr.video.title ?? "Untitled", 24) : "no data yet"} />
        <SummaryStat
          label={summary.missingThumb > 0 ? "Needs response · thumbs" : "Needs response"}
          value={formatCompact(summary.needsResponse)}
          sub={summary.missingThumb > 0 ? `${summary.missingThumb} missing thumbnail` : "comments awaiting a reply"}
        />
      </section>

      {/* Growth Leaders */}
      {leaders.length > 0 && (
        <section className="section-enter" style={{ animationDelay: "60ms" }} aria-label="Growth leaders">
          <div className="mb-2.5 flex items-center gap-2">
            <TrendingUp size={15} className="text-accent" />
            <h2 className="text-sm font-semibold tracking-tight">Growth leaders</h2>
            <span className="text-[11px] text-muted-strong">most views gained · {rangeLabel}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {leaders.map((r, i) => (
              <GrowthLeaderCard key={r.video.id} r={r} rank={i + 1} onOpen={() => setOpenId(r.video.id)} />
            ))}
          </div>
        </section>
      )}

      {/* Filters */}
      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-strong" />
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title or caption…" aria-label="Search videos" className={clsx(inputCls, "w-full pl-8")} />
          </div>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} aria-label="Sort videos by" className={inputCls}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>Sort: {SORT_LABELS[k]}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            aria-label={sortDir === "desc" ? "Descending — switch to ascending" : "Ascending — switch to descending"}
            title={sortDir === "desc" ? "Descending" : "Ascending"}
            className="rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-muted transition-colors hover:text-foreground"
          >
            {sortDir === "desc" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by platform">
            <button type="button" onClick={() => setPlatform("all")} aria-pressed={platform === "all"} className={clsx("rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors", platform === "all" ? "border-border-strong bg-surface-hover text-foreground" : "border-border text-muted hover:bg-surface-hover hover:text-foreground")}>
              All platforms
            </button>
            {PLATFORMS.map((p) => {
              const c = PLATFORM_COLORS[p];
              const active = platform === p;
              return (
                <button key={p} type="button" onClick={() => setPlatform(active ? "all" : p)} aria-pressed={active} className={clsx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors", active ? clsx("border-border-strong", c.bg, c.text) : "border-border text-muted hover:bg-surface-hover hover:text-foreground")}>
                  <span className={clsx("h-1.5 w-1.5 rounded-full", c.dot, !active && "opacity-50")} />
                  {PLATFORM_LABELS[p]}
                </button>
              );
            })}
          </div>
          <select value={episode} onChange={(e) => setEpisode(e.target.value)} aria-label="Filter by episode" className={inputCls}>
            <option value="all">All episodes</option>
            <option value="unassigned">Unassigned</option>
            {episodes.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Filter by status" className={inputCls}>
            <option value="all">Any status</option>
            <option value="surging">Surging</option>
            <option value="new">New (48h)</option>
            <option value="needs-response">Needs response</option>
            <option value="verified">Verified</option>
            <option value="no-thumbnail">Missing thumbnail</option>
            <option value="awaiting-views">Awaiting views</option>
          </select>
          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted hover:text-foreground">
            <input type="checkbox" checked={hasComments} onChange={(e) => setHasComments(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
            Has comments
          </label>
          {hiddenCount > 0 && (
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted hover:text-foreground">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--accent)]" />
              Show hidden ({hiddenCount})
            </label>
          )}
          {hasFilters && (
            <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline">
              <FilterX size={11} /> Clear filters
            </button>
          )}
        </div>
      </Card>

      <div className="flex items-center justify-between px-1 text-xs text-muted">
        <span>
          Showing <span className="tabular-nums font-medium text-foreground">{sorted.length}</span> of <span className="tabular-nums">{visible.length}</span> videos
        </span>
        <span className="flex items-center gap-1 text-muted-strong">
          <Eye size={11} /> click a video for full detail
        </span>
      </div>

      {/* Card grid */}
      {sorted.length === 0 ? (
        <EmptyState icon={<FilterX size={24} />} title="No videos match these filters" detail="Try a different platform, episode, status, or search term." action={<button type="button" onClick={clearFilters} className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium hover:bg-surface-hover">Clear filters</button>} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {sorted.map((r) => (
            <VideoCard key={r.video.id} r={r} now={now} onOpen={() => setOpenId(r.video.id)} />
          ))}
        </div>
      )}

      {openRow && <DetailDrawer r={openRow} now={now} onClose={() => setOpenId(null)} />}
    </div>
  );
}
