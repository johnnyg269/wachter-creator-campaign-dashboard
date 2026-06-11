"use client";

// All-client video library table: platform/episode/date/search filters,
// null-safe sorting, responsive (dense table on lg+, stacked cards below).

import { useMemo, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  EyeOff,
  Film,
  FilterX,
  Layers,
  Search,
  UserRound,
} from "lucide-react";
import type { Delta, VideoMetrics } from "@/lib/metrics";
import type { EpisodeGroup, Platform, VideoStatus } from "@/lib/types";
import { PLATFORMS, PLATFORM_LABELS } from "@/lib/types";
import { formatCompact, formatDate, formatPct } from "@/lib/format";
import { Card } from "@/components/ui/card";
import { DeltaTag } from "@/components/ui/delta";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_COLORS, PlatformBadge } from "@/components/ui/platform";
import { StatusPill } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/time-ago";
import { VideoThumb } from "@/components/ui/video-thumb";

export type VideoRow = VideoMetrics & {
  episodeName: string | null;
  profileUrl: string | null;
};

type SortKey = "views" | "growth24h" | "engagementRate" | "comments" | "publishedAt";
type SortDir = "asc" | "desc";

const SORT_LABELS: Record<SortKey, string> = {
  views: "Views",
  growth24h: "24h growth",
  engagementRate: "Engagement rate",
  comments: "Comments",
  publishedAt: "Published date",
};

const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];

/** Numeric sort value; null means "no data" and always sorts last. */
function sortValue(row: VideoRow, key: SortKey): number | null {
  switch (key) {
    case "views":
      return row.latest?.views ?? null;
    case "growth24h":
      return row.delta24h?.value ?? null;
    case "engagementRate":
      return row.engagementRate;
    case "comments":
      return row.latest?.comments ?? null;
    case "publishedAt": {
      if (!row.video.publishedAt) return null;
      const t = Date.parse(row.video.publishedAt);
      return Number.isNaN(t) ? null : t;
    }
  }
}

const VIDEO_STATUS_BADGE: Record<
  Exclude<VideoStatus, "active">,
  { label: string; className: string }
> = {
  unavailable: { label: "Unavailable", className: "text-warning bg-[rgba(251,191,36,0.1)]" },
  needs_auth: { label: "Needs auth", className: "text-warning bg-[rgba(251,191,36,0.1)]" },
  failed_fetch: { label: "Fetch failed", className: "text-negative bg-[rgba(248,113,113,0.12)]" },
};

function VideoStatusBadge({ status }: { status: VideoStatus }) {
  if (status === "active") return null;
  const s = VIDEO_STATUS_BADGE[status];
  return (
    <span
      className={clsx(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap",
        s.className,
      )}
    >
      {s.label}
    </span>
  );
}

function EpisodeChip({ name }: { name: string | null }) {
  if (!name) {
    return <span className="text-[10px] text-muted-strong whitespace-nowrap">Unassigned</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-muted whitespace-nowrap">
      <Layers size={9} className="shrink-0" />
      {name}
    </span>
  );
}

/** DeltaTag wrapper that flags partial-window 24h deltas. */
function Growth24h({ delta }: { delta: Delta | null }) {
  if (!delta) return <DeltaTag value={null} />;
  return (
    <span
      title={
        delta.coversFullWindow
          ? undefined
          : "Tracked for less than the full 24h window — growth since first snapshot"
      }
    >
      <DeltaTag value={delta.value} />
      {!delta.coversFullWindow && <span className="text-[10px] text-muted-strong">*</span>}
    </span>
  );
}

const inputCls =
  "rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-strong focus:border-accent focus:outline-none";

const btnCls =
  "rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-hover hover:border-border-strong";

/** Sticky table header cell: solid bg so rows scroll cleanly beneath it. */
const thCls =
  "border-b border-border bg-surface-raised px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap";

function SortHeaderButton({
  k,
  sortKey,
  sortDir,
  onSort,
}: {
  k: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-label={`Sort by ${SORT_LABELS[k]}`}
      className={clsx(
        "inline-flex items-center gap-1 uppercase tracking-wide transition-colors",
        active ? "text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      {SORT_LABELS[k] === "Engagement rate" ? "ER" : SORT_LABELS[k]}
      {active ? (
        sortDir === "desc" ? (
          <ArrowDown size={11} />
        ) : (
          <ArrowUp size={11} />
        )
      ) : (
        <ArrowUpDown size={11} className="opacity-40" />
      )}
    </button>
  );
}

function MetricTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-surface px-2 py-1.5">
      <div className="text-[9px] font-medium uppercase tracking-wide text-muted-strong">
        {label}
      </div>
      <div className="tabular mt-0.5 text-[13px] font-semibold">{children}</div>
    </div>
  );
}

export function VideosTable({ rows, episodes }: { rows: VideoRow[]; episodes: EpisodeGroup[] }) {
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [episode, setEpisode] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("views");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const hiddenCount = useMemo(() => rows.filter((r) => r.video.hidden).length, [rows]);

  const visibleRows = useMemo(
    () => (showHidden ? rows : rows.filter((r) => !r.video.hidden)),
    [rows, showHidden],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleRows.filter((r) => {
      const v = r.video;
      if (platform !== "all" && v.platform !== platform) return false;
      if (episode === "unassigned") {
        if (v.episodeGroupId !== null) return false;
      } else if (episode !== "all" && v.episodeGroupId !== episode) {
        return false;
      }
      if (dateFrom || dateTo) {
        if (!v.publishedAt) return false;
        const day = v.publishedAt.slice(0, 10);
        if (dateFrom && day < dateFrom) return false;
        if (dateTo && day > dateTo) return false;
      }
      if (q) {
        const haystack = `${v.title ?? ""} ${v.caption ?? ""}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [visibleRows, platform, episode, dateFrom, dateTo, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // nulls always last, either direction
      if (bv === null) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [filtered, sortKey, sortDir]);

  const hasActiveFilters =
    platform !== "all" || episode !== "all" || dateFrom !== "" || dateTo !== "" || search.trim() !== "";

  function clearFilters() {
    setPlatform("all");
    setEpisode("all");
    setDateFrom("");
    setDateTo("");
    setSearch("");
  }

  function onSort(k: SortKey) {
    if (k === sortKey) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  const hasPartialWindow = sorted.some((r) => r.delta24h && !r.delta24h.coversFullWindow);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Film size={24} />}
        title="No videos tracked yet"
        detail="Videos appear here after the first successful refresh. Connect a platform provider in Admin or trigger a manual refresh to start tracking."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── Filter bar ─────────────────────────────────────────────────── */}
      <Card className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search
              size={13}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-strong"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title or caption…"
              aria-label="Search videos by title or caption"
              className={clsx(inputCls, "w-full pl-8")}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              aria-label="Sort videos by"
              className={inputCls}
            >
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>
                  Sort: {SORT_LABELS[k]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
              aria-label={sortDir === "desc" ? "Sorted high to low — switch to ascending" : "Sorted low to high — switch to descending"}
              title={sortDir === "desc" ? "Descending" : "Ascending"}
              className={clsx(btnCls, "px-2.5 text-muted hover:text-foreground")}
            >
              {sortDir === "desc" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by platform">
            <button
              type="button"
              onClick={() => setPlatform("all")}
              aria-pressed={platform === "all"}
              className={clsx(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                platform === "all"
                  ? "border-border-strong bg-surface-hover text-foreground"
                  : "border-border text-muted hover:bg-surface-hover hover:text-foreground",
              )}
            >
              All platforms
            </button>
            {PLATFORMS.map((p) => {
              const c = PLATFORM_COLORS[p];
              const active = platform === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPlatform(active ? "all" : p)}
                  aria-pressed={active}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap transition-colors",
                    active
                      ? clsx("border-border-strong", c.bg, c.text)
                      : "border-border text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <span className={clsx("h-1.5 w-1.5 rounded-full", c.dot, !active && "opacity-50")} />
                  {PLATFORM_LABELS[p]}
                </button>
              );
            })}
          </div>

          <select
            value={episode}
            onChange={(e) => setEpisode(e.target.value)}
            aria-label="Filter by episode"
            className={inputCls}
          >
            <option value="all">All episodes</option>
            <option value="unassigned">Unassigned</option>
            {episodes.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="text-[11px] text-muted-strong">Published</span>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="Published on or after"
              className={inputCls}
            />
            <span aria-hidden="true" className="text-muted-strong">
              –
            </span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => setDateTo(e.target.value)}
              aria-label="Published on or before"
              className={inputCls}
            />
          </div>

          <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted hover:text-foreground">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Show hidden{hiddenCount > 0 ? ` (${hiddenCount})` : ""}
          </label>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
            >
              <FilterX size={11} />
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {/* ── Result count ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted">
        <span>
          Showing <span className="tabular font-medium text-foreground">{sorted.length}</span> of{" "}
          <span className="tabular">{visibleRows.length}</span> videos
          {!showHidden && hiddenCount > 0 && (
            <span className="text-muted-strong"> · {hiddenCount} hidden excluded</span>
          )}
        </span>
        <span className="text-muted-strong">
          Sorted by {SORT_LABELS[sortKey].toLowerCase()} ({sortDir === "desc" ? "desc" : "asc"})
        </span>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={<FilterX size={24} />}
          title="No videos match these filters"
          detail={
            visibleRows.length === 0 && hiddenCount > 0
              ? `All ${rows.length} tracked videos are currently hidden. Turn on "Show hidden" to see them.`
              : "Try a different platform, episode, date range, or search term."
          }
          action={
            visibleRows.length === 0 && hiddenCount > 0 ? (
              <button type="button" onClick={() => setShowHidden(true)} className={btnCls}>
                Show hidden videos
              </button>
            ) : (
              <button type="button" onClick={clearFilters} className={btnCls}>
                Clear filters
              </button>
            )
          }
        />
      ) : (
        <>
          {/* ── Desktop table ──────────────────────────────────────────── */}
          <Card className="hidden overflow-hidden lg:block">
            <div className="max-h-[72vh] overflow-auto">
              <table className="w-full min-w-[1100px] border-separate border-spacing-0 text-sm">
                <thead className="sticky top-0 z-10">
                  <tr>
                    <th className={clsx(thCls, "w-[30%] min-w-[300px] text-left")}>
                      <span className="text-muted">Video</span>
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <SortHeaderButton k="views" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <SortHeaderButton k="growth24h" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <span className="text-muted">Since tracked</span>
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <SortHeaderButton k="engagementRate" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <span className="text-muted">Likes</span>
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <SortHeaderButton k="comments" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <span className="text-muted">Shares</span>
                    </th>
                    <th className={clsx(thCls, "text-right")}>
                      <span className="text-muted">Saves</span>
                    </th>
                    <th className={clsx(thCls, "text-left")}>
                      <SortHeaderButton k="publishedAt" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                    </th>
                    <th className={clsx(thCls, "text-left")}>
                      <span className="text-muted">Source</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((row) => {
                    const v = row.video;
                    const title = v.title ?? v.caption ?? "Untitled video";
                    const secondary =
                      v.title && v.caption && v.caption !== v.title ? v.caption : null;
                    const saves = row.latest?.saves ?? row.latest?.bookmarks ?? null;
                    return (
                      <tr key={v.id} className="transition-colors hover:bg-surface-hover/50">
                        <td className="border-b border-border px-3 py-3">
                          <div className="flex items-start gap-3">
                            <VideoThumb
                              src={v.thumbnailUrl}
                              platform={v.platform}
                              alt={title}
                              className="h-16 w-11 shrink-0"
                            />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <PlatformBadge platform={v.platform} size="sm" />
                                <EpisodeChip name={row.episodeName} />
                                <VideoStatusBadge status={v.status} />
                                {v.hidden && (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-muted-strong">
                                    <EyeOff size={9} />
                                    Hidden
                                  </span>
                                )}
                                {row.profileUrl && (
                                  <a
                                    href={row.profileUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    aria-label="Open creator profile"
                                    title="Creator profile"
                                    className="text-muted-strong transition-colors hover:text-accent"
                                  >
                                    <UserRound size={12} />
                                  </a>
                                )}
                              </div>
                              <a
                                href={v.originalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-1 line-clamp-2 block text-[13px] font-medium leading-snug transition-colors hover:text-accent"
                              >
                                {title}
                              </a>
                              {secondary && (
                                <div className="mt-0.5 line-clamp-1 text-[11px] text-muted">
                                  {secondary}
                                </div>
                              )}
                              {v.errorMessage && (
                                <div
                                  className="mt-1 flex items-center gap-1 text-[11px] text-negative"
                                  title={v.errorMessage}
                                >
                                  <AlertTriangle size={11} className="shrink-0" />
                                  <span className="line-clamp-1">{v.errorMessage}</span>
                                </div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="tabular border-b border-border px-3 py-3 text-right font-semibold">
                          {formatCompact(row.latest?.views ?? null)}
                        </td>
                        <td className="border-b border-border px-3 py-3 text-right">
                          <Growth24h delta={row.delta24h} />
                        </td>
                        <td className="border-b border-border px-3 py-3 text-right">
                          <DeltaTag value={row.growthSinceTracked} />
                        </td>
                        <td className="tabular border-b border-border px-3 py-3 text-right">
                          {formatPct(row.engagementRate)}
                        </td>
                        <td className="tabular border-b border-border px-3 py-3 text-right text-muted">
                          {formatCompact(row.latest?.likes ?? null)}
                        </td>
                        <td className="tabular border-b border-border px-3 py-3 text-right text-muted">
                          {formatCompact(row.latest?.comments ?? null)}
                        </td>
                        <td className="tabular border-b border-border px-3 py-3 text-right text-muted">
                          {formatCompact(row.latest?.shares ?? null)}
                        </td>
                        <td className="tabular border-b border-border px-3 py-3 text-right text-muted">
                          {formatCompact(saves)}
                        </td>
                        <td className="border-b border-border px-3 py-3 whitespace-nowrap">
                          <div className="text-xs">{formatDate(v.publishedAt)}</div>
                          <div className="mt-0.5 text-[10px] text-muted-strong">
                            tracked <TimeAgo iso={v.firstTrackedAt} />
                          </div>
                        </td>
                        <td className="border-b border-border px-3 py-3 whitespace-nowrap">
                          <StatusPill status={v.sourceStatus} detail={v.errorMessage} size="sm" />
                          <div className="mt-1 text-[10px] text-muted-strong">
                            {v.lastRefreshedAt ? (
                              <>
                                updated <TimeAgo iso={v.lastRefreshedAt} />
                              </>
                            ) : (
                              "never refreshed"
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* ── Mobile cards ───────────────────────────────────────────── */}
          <div className="flex flex-col gap-3 lg:hidden">
            {sorted.map((row) => {
              const v = row.video;
              const title = v.title ?? v.caption ?? "Untitled video";
              const saves = row.latest?.saves ?? row.latest?.bookmarks ?? null;
              return (
                <Card key={v.id} className="px-3.5 py-3">
                  <div className="flex items-start gap-3">
                    <VideoThumb
                      src={v.thumbnailUrl}
                      platform={v.platform}
                      alt={title}
                      className="h-20 w-14 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <PlatformBadge platform={v.platform} size="sm" />
                        <VideoStatusBadge status={v.status} />
                        {v.hidden && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-muted-strong">
                            <EyeOff size={9} />
                            Hidden
                          </span>
                        )}
                        {row.profileUrl && (
                          <a
                            href={row.profileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Open creator profile"
                            title="Creator profile"
                            className="text-muted-strong transition-colors hover:text-accent"
                          >
                            <UserRound size={12} />
                          </a>
                        )}
                      </div>
                      <a
                        href={v.originalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 line-clamp-2 block text-[13px] font-medium leading-snug transition-colors hover:text-accent"
                      >
                        {title}
                      </a>
                      {v.errorMessage && (
                        <div
                          className="mt-1 flex items-center gap-1 text-[11px] text-negative"
                          title={v.errorMessage}
                        >
                          <AlertTriangle size={11} className="shrink-0" />
                          <span className="line-clamp-1">{v.errorMessage}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                    <MetricTile label="Views">{formatCompact(row.latest?.views ?? null)}</MetricTile>
                    <MetricTile label="24h">
                      <Growth24h delta={row.delta24h} />
                    </MetricTile>
                    <MetricTile label="ER">{formatPct(row.engagementRate)}</MetricTile>
                    <MetricTile label="Likes">{formatCompact(row.latest?.likes ?? null)}</MetricTile>
                    <MetricTile label="Comments">
                      {formatCompact(row.latest?.comments ?? null)}
                    </MetricTile>
                    <MetricTile label="Shares">{formatCompact(row.latest?.shares ?? null)}</MetricTile>
                    <MetricTile label="Saves">{formatCompact(saves)}</MetricTile>
                    <MetricTile label="Since tracked">
                      <DeltaTag value={row.growthSinceTracked} className="text-[13px]" />
                    </MetricTile>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-2.5 text-[10px] text-muted-strong">
                    <span>Published {formatDate(v.publishedAt)}</span>
                    <span>
                      tracked <TimeAgo iso={v.firstTrackedAt} />
                    </span>
                    <span>
                      {v.lastRefreshedAt ? (
                        <>
                          updated <TimeAgo iso={v.lastRefreshedAt} />
                        </>
                      ) : (
                        "never refreshed"
                      )}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <EpisodeChip name={row.episodeName} />
                      <StatusPill status={v.sourceStatus} detail={v.errorMessage} size="sm" />
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>

          {hasPartialWindow && (
            <div className="px-1 text-[10px] text-muted-strong">
              * Tracked for less than the full 24h window — growth shown since first snapshot.
            </div>
          )}
        </>
      )}
    </div>
  );
}
