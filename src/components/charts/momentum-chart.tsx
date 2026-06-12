"use client";

// Campaign momentum chart — the dashboard's centerpiece. Tells the growth
// story rather than just plotting totals: gradient area clamped to real
// history, a highlighted "now" marker on the latest reading, metric toggle
// (views/engagements/comments), and a tooltip that breaks the total down by
// platform with the gain since the previous snapshot. Gaps stay gaps — a
// missing reading is never drawn as zero.

import { useMemo, useState } from "react";
import clsx from "clsx";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint } from "@/lib/metrics";
import type { Platform } from "@/lib/types";
import { PLATFORM_LABELS } from "@/lib/types";
import { formatCompact, formatDelta } from "@/lib/format";

type Metric = "views" | "engagements" | "comments";

const METRIC_META: Record<Metric, { label: string; color: string; fillId: string }> = {
  views: { label: "Views", color: "#60a5fa", fillId: "momFillViews" },
  engagements: { label: "Engagements", color: "#34d399", fillId: "momFillEng" },
  comments: { label: "Comments", color: "#c084fc", fillId: "momFillComments" },
};

const PLATFORM_COLORS: Record<Platform, string> = {
  tiktok: "#25f4ee",
  youtube: "#ff4444",
  instagram: "#e95daa",
  facebook: "#4b8dff",
};

interface Row {
  t: string;
  label: string;
  views: number | null;
  engagements: number | null;
  comments: number | null;
  gained: Record<Metric, number | null>;
  byPlatform: Partial<Record<Platform, Record<Metric, number | null>>>;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildRows(
  data: TrendPoint[],
  byPlatform: Partial<Record<Platform, TrendPoint[]>>,
): Row[] {
  const prev: Record<Metric, number | null> = { views: null, engagements: null, comments: null };
  return data.map((p, i) => {
    const gained: Record<Metric, number | null> = { views: null, engagements: null, comments: null };
    for (const m of ["views", "engagements", "comments"] as Metric[]) {
      const v = p[m];
      if (v !== null && prev[m] !== null) gained[m] = v - (prev[m] as number);
      if (v !== null) prev[m] = v;
    }
    const rowPlatforms: Row["byPlatform"] = {};
    for (const [platform, series] of Object.entries(byPlatform) as Array<
      [Platform, TrendPoint[]]
    >) {
      const pt = series[i];
      if (pt) {
        rowPlatforms[platform] = {
          views: pt.views,
          engagements: pt.engagements,
          comments: pt.comments,
        };
      }
    }
    return {
      t: p.t,
      label: shortTime(p.t),
      views: p.views,
      engagements: p.engagements,
      comments: p.comments,
      gained,
      byPlatform: rowPlatforms,
    };
  });
}

function MomentumTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Row }>;
  metric: Metric;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const value = row[metric];
  const gained = row.gained[metric];
  const breakdown = (Object.entries(row.byPlatform) as Array<
    [Platform, Record<Metric, number | null>]
  >)
    .map(([platform, vals]) => ({ platform, value: vals[metric] }))
    .filter((b) => b.value !== null)
    .sort((a, b) => (b.value as number) - (a.value as number));
  return (
    <div className="min-w-[180px] rounded-xl border border-border-strong bg-surface-raised px-3.5 py-3 text-xs shadow-2xl">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">
        {row.label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="tabular-nums text-base font-semibold leading-none">
          {formatCompact(value)}
        </span>
        <span className="text-muted">{METRIC_META[metric].label.toLowerCase()}</span>
        {gained !== null && gained !== 0 && (
          <span
            className={clsx(
              "tabular-nums text-[11px] font-medium",
              gained > 0 ? "text-positive" : "text-negative",
            )}
          >
            {formatDelta(gained)}
          </span>
        )}
      </div>
      {breakdown.length > 0 && (
        <div className="mt-2.5 space-y-1 border-t border-border pt-2">
          {breakdown.map((b) => (
            <div key={b.platform} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: PLATFORM_COLORS[b.platform] }}
                />
                {PLATFORM_LABELS[b.platform]}
              </span>
              <span className="tabular-nums font-medium">{formatCompact(b.value)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MomentumChart({
  data,
  byPlatform,
  height = 300,
}: {
  data: TrendPoint[];
  byPlatform: Partial<Record<Platform, TrendPoint[]>>;
  height?: number;
}) {
  const [metric, setMetric] = useState<Metric>("views");
  const rows = useMemo(() => buildRows(data, byPlatform), [data, byPlatform]);
  const meta = METRIC_META[metric];
  const withData = rows.filter((r) => r[metric] !== null);
  const last = withData[withData.length - 1] ?? null;
  const hasMetric = withData.length > 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg border border-border bg-surface p-0.5">
          {(Object.keys(METRIC_META) as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              aria-pressed={m === metric}
              className={clsx(
                "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                m === metric
                  ? "bg-surface-hover text-foreground shadow-sm"
                  : "text-muted hover:text-foreground",
              )}
            >
              <span
                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: METRIC_META[m].color }}
              />
              {METRIC_META[m].label}
            </button>
          ))}
        </div>
        {last && (
          <div className="flex items-baseline gap-1.5 text-xs text-muted">
            <span aria-hidden className="relative flex h-2 w-2">
              <span
                className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50"
                style={{ background: meta.color }}
              />
              <span
                className="relative inline-flex h-2 w-2 rounded-full"
                style={{ background: meta.color }}
              />
            </span>
            Now:{" "}
            <span className="tabular-nums font-semibold text-foreground">
              {formatCompact(last[metric])}
            </span>
            {meta.label.toLowerCase()}
          </div>
        )}
      </div>
      {!hasMetric ? (
        <div
          className="flex items-center justify-center text-xs text-muted-strong"
          style={{ height }}
        >
          No {meta.label.toLowerCase()} data captured yet for this range.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={rows} margin={{ top: 10, right: 14, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={meta.fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={meta.color} stopOpacity={0.3} />
                <stop offset="55%" stopColor={meta.color} stopOpacity={0.07} />
                <stop offset="100%" stopColor={meta.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="#1a2130"
              strokeOpacity={0.5}
              strokeDasharray="2 6"
              vertical={false}
            />
            <XAxis
              dataKey="t"
              tickFormatter={shortTime}
              stroke="#5c6878"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              minTickGap={64}
              tickMargin={8}
            />
            <YAxis
              stroke="#5c6878"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              width={46}
              tickCount={4}
              domain={["auto", "auto"]}
              tickFormatter={(v: number) => formatCompact(v)}
            />
            <Tooltip
              content={<MomentumTooltip metric={metric} />}
              cursor={{ stroke: "#2a3447", strokeWidth: 1, strokeDasharray: "3 3" }}
            />
            <Area
              type="monotone"
              dataKey={metric}
              stroke={meta.color}
              strokeWidth={2.25}
              fill={`url(#${meta.fillId})`}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: meta.color }}
            />
            {last && last[metric] !== null && (
              <ReferenceDot
                x={last.t}
                y={last[metric] as number}
                r={4.5}
                fill={meta.color}
                stroke="var(--background)"
                strokeWidth={2}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
