"use client";

// Episodes → concept performance. Replaces the old best-platform-colored
// bar chart with an outlier-aware, platform-stacked layout:
//   - the leading concept gets a featured row (it no longer crushes the axis)
//   - remaining concepts render as ranked stacked bars scaled to THEIR max,
//     each labeled with its real absolute value (no misrepresentation)
//   - every bar stacks real per-platform totals in platform colors
// Props are plain serialized rows precomputed on the server — no raw actor
// payloads cross into the client bundle.

import { useState } from "react";
import clsx from "clsx";
import type { Platform } from "@/lib/types";
import { PLATFORM_LABELS, PLATFORMS } from "@/lib/types";
import { formatCompact, formatPct } from "@/lib/format";

const PLATFORM_HEX: Record<Platform, string> = {
  tiktok: "#25f4ee",
  youtube: "#ff4444",
  instagram: "#e95daa",
  facebook: "#4b8dff",
};

export interface ConceptRow {
  id: string;
  name: string;
  videoCount: number;
  /** Per-platform confirmed totals for each metric. */
  perPlatform: Partial<Record<Platform, { views: number; engagements: number }>>;
  totalViews: number | null;
  totalEngagements: number | null;
  totalComments: number | null;
  engagementRate: number | null;
  topPlatform: Platform | null;
  topVideo: { title: string; url: string; views: number | null } | null;
}

type Metric = "views" | "engagements" | "perVideo";

const METRIC_LABELS: Record<Metric, string> = {
  views: "Views",
  engagements: "Engagements",
  perVideo: "Views / video",
};

function metricTotal(row: ConceptRow, metric: Metric): number {
  if (metric === "views") return row.totalViews ?? 0;
  if (metric === "engagements") return row.totalEngagements ?? 0;
  return row.videoCount > 0 ? Math.round((row.totalViews ?? 0) / row.videoCount) : 0;
}

function platformValue(row: ConceptRow, p: Platform, metric: Metric): number {
  const entry = row.perPlatform[p];
  if (!entry) return 0;
  if (metric === "engagements") return entry.engagements;
  if (metric === "perVideo") return row.videoCount > 0 ? entry.views / row.videoCount : 0;
  return entry.views;
}

function rowTitle(row: ConceptRow): string {
  const parts = [
    row.name,
    `${formatCompact(row.totalViews)} views`,
    row.totalEngagements !== null ? `${formatCompact(row.totalEngagements)} engagements` : null,
    row.totalComments !== null ? `${formatCompact(row.totalComments)} comments` : null,
    `${row.videoCount} video${row.videoCount === 1 ? "" : "s"}`,
    row.videoCount > 0 && row.totalViews !== null
      ? `${formatCompact(Math.round(row.totalViews / row.videoCount))} views/video`
      : null,
    ...PLATFORMS.filter((p) => row.perPlatform[p]).map(
      (p) => `${PLATFORM_LABELS[p]}: ${formatCompact(row.perPlatform[p]?.views ?? 0)}`,
    ),
    row.topVideo ? `Top video: ${row.topVideo.title}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function StackedBar({
  row,
  metric,
  scaleMax,
  tall,
}: {
  row: ConceptRow;
  metric: Metric;
  scaleMax: number;
  tall?: boolean;
}) {
  const total = metricTotal(row, metric);
  const widthPct = scaleMax > 0 ? Math.max(total > 0 ? 1.5 : 0, (total / scaleMax) * 100) : 0;
  const platformVals = PLATFORMS.map((p) => ({ p, v: platformValue(row, p, metric) })).filter(
    (x) => x.v > 0,
  );
  const segTotal = platformVals.reduce((a, b) => a + b.v, 0);
  return (
    <div
      className={clsx("overflow-hidden rounded-full bg-surface-hover", tall ? "h-3" : "h-2")}
      role="img"
      aria-label={`${row.name}: ${formatCompact(total)} ${METRIC_LABELS[metric].toLowerCase()}`}
    >
      <div className="bar-fill flex h-full" style={{ width: `${widthPct}%` }}>
        {segTotal > 0 ? (
          platformVals.map(({ p, v }) => (
            <div
              key={p}
              className="h-full"
              style={{ width: `${(v / segTotal) * 100}%`, background: PLATFORM_HEX[p], opacity: 0.88 }}
              title={`${PLATFORM_LABELS[p]}: ${formatCompact(Math.round(v))}`}
            />
          ))
        ) : (
          <div className="h-full w-full bg-muted-strong/40" />
        )}
      </div>
    </div>
  );
}

export function ConceptPerformance({ rows }: { rows: ConceptRow[] }) {
  const [metric, setMetric] = useState<Metric>("views");
  const ranked = [...rows].sort((a, b) => metricTotal(b, metric) - metricTotal(a, metric));
  const withData = ranked.filter((r) => metricTotal(r, metric) > 0);
  if (withData.length === 0) return null;

  const [leader, ...rest] = withData;
  const restMax = rest.length > 0 ? metricTotal(rest[0], metric) : 0;

  return (
    <div>
      {/* Controls + legend */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-0.5 rounded-full border border-border bg-background/60 p-1">
          {(Object.keys(METRIC_LABELS) as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              aria-pressed={m === metric}
              className={clsx(
                "rounded-full px-3 py-1 text-[11px] font-medium transition-all duration-200",
                m === metric
                  ? "bg-surface-hover text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_1px_3px_rgba(0,0,0,0.4)] ring-1 ring-border-strong"
                  : "text-muted hover:text-foreground",
              )}
            >
              {METRIC_LABELS[m]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {PLATFORMS.map((p) => (
            <span key={p} className="flex items-center gap-1.5 text-[10px] text-muted-strong">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: PLATFORM_HEX[p] }} />
              {PLATFORM_LABELS[p]}
            </span>
          ))}
        </div>
      </div>

      {/* Featured leading concept — the outlier gets its own stage */}
      <div
        className="rounded-xl border border-accent/25 bg-[radial-gradient(ellipse_70%_140%_at_8%_50%,rgba(59,130,246,0.08),transparent_60%)] px-4 py-3.5"
        title={rowTitle(leader)}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
              Leading concept
            </span>
            <span className="truncate text-sm font-semibold tracking-tight">{leader.name}</span>
          </div>
          <span className="tabular-nums text-xl font-bold tracking-tight">
            {formatCompact(metricTotal(leader, metric))}
            <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-strong">
              {METRIC_LABELS[metric]}
            </span>
          </span>
        </div>
        <div className="mt-2.5">
          <StackedBar row={leader} metric={metric} scaleMax={metricTotal(leader, metric)} tall />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
          <span className="tabular-nums">
            {leader.videoCount} video{leader.videoCount === 1 ? "" : "s"}
          </span>
          {leader.topPlatform && <span>{PLATFORM_LABELS[leader.topPlatform]}-led</span>}
          {leader.videoCount > 0 && leader.totalViews !== null && (
            <span className="tabular-nums">
              {formatCompact(Math.round(leader.totalViews / leader.videoCount))} views/video
            </span>
          )}
          {leader.engagementRate !== null && (
            <span className="tabular-nums">{formatPct(leader.engagementRate)} ER</span>
          )}
        </div>
      </div>

      {/* Remaining concepts — scaled to THEIR max so they stay readable.
          Absolute values are always labeled; the scale never lies silently. */}
      {rest.length > 0 && (
        <div className="mt-3 space-y-3 px-1">
          {rest.map((r) => (
            <div key={r.id} className="group" title={rowTitle(r)}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-xs font-medium text-foreground/90 transition-colors group-hover:text-foreground">
                  {r.name}
                </span>
                <span className="tabular-nums shrink-0 text-xs font-semibold">
                  {formatCompact(metricTotal(r, metric))}
                  <span className="ml-2 font-normal text-muted-strong">
                    {r.videoCount} vid{r.videoCount === 1 ? "" : "s"}
                    {r.topPlatform ? ` · ${PLATFORM_LABELS[r.topPlatform]}-led` : ""}
                  </span>
                </span>
              </div>
              <div className="mt-1">
                <StackedBar row={r} metric={metric} scaleMax={restMax} />
              </div>
            </div>
          ))}
          <p className="pt-1 text-[10px] text-muted-strong">
            Leading concept shown separately above · remaining bars scaled to “
            {rest[0]?.name && rest[0].name.length > 28 ? `${rest[0].name.slice(0, 28)}…` : rest[0]?.name}
            ” for readability — labels show real totals
          </p>
        </div>
      )}
    </div>
  );
}
