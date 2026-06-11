"use client";

// Performance trend chart. Executive-friendly: clamped to real history (the
// query layer trims dead space), metric toggle (views/engagements/comments),
// tooltip that shows the gain since the previous snapshot, soft gradient fill,
// quiet grid, no dominating cursor line. Gaps (null) stay gaps — never zeros.

import { useMemo, useState } from "react";
import clsx from "clsx";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint } from "@/lib/metrics";
import { formatCompact, formatDelta } from "@/lib/format";

type Metric = "views" | "engagements" | "comments";

const METRIC_META: Record<Metric, { label: string; color: string; fillId: string }> = {
  views: { label: "Views", color: "#60a5fa", fillId: "trendFillViews" },
  engagements: { label: "Engagements", color: "#34d399", fillId: "trendFillEng" },
  comments: { label: "Comments", color: "#c084fc", fillId: "trendFillComments" },
};

interface Row {
  t: string;
  label: string;
  views: number | null;
  engagements: number | null;
  comments: number | null;
  /** Gain vs the previous non-null point, per metric. */
  gained: Record<Metric, number | null>;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function buildRows(data: TrendPoint[]): Row[] {
  const prev: Record<Metric, number | null> = { views: null, engagements: null, comments: null };
  return data.map((p) => {
    const gained: Record<Metric, number | null> = { views: null, engagements: null, comments: null };
    for (const m of ["views", "engagements", "comments"] as Metric[]) {
      const v = p[m];
      if (v !== null && prev[m] !== null) gained[m] = v - (prev[m] as number);
      if (v !== null) prev[m] = v;
    }
    return { t: p.t, label: shortTime(p.t), views: p.views, engagements: p.engagements, comments: p.comments, gained };
  });
}

function TrendTooltip({
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
  return (
    <div className="rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-xs shadow-xl">
      <div className="text-[10px] text-muted-strong">{row.label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="tabular text-sm font-semibold">{formatCompact(value)}</span>
        <span className="text-muted">{METRIC_META[metric].label.toLowerCase()}</span>
      </div>
      {gained !== null && gained !== 0 && (
        <div className={clsx("tabular text-[11px]", gained > 0 ? "text-positive" : "text-negative")}>
          {formatDelta(gained)} since previous snapshot
        </div>
      )}
      {metric === "views" && row.engagements !== null && (
        <div className="mt-0.5 text-[11px] text-muted">
          {formatCompact(row.engagements)} engagements
        </div>
      )}
    </div>
  );
}

export function TrendChart({
  data,
  height = 280,
  mini = false,
  initialMetric = "views",
}: {
  data: TrendPoint[];
  height?: number;
  /** Mini mode: no controls/axes labels — used in platform cards. */
  mini?: boolean;
  initialMetric?: Metric;
}) {
  const [metric, setMetric] = useState<Metric>(initialMetric);
  const rows = useMemo(() => buildRows(data), [data]);
  const meta = METRIC_META[metric];
  const hasMetric = rows.some((r) => r[metric] !== null);

  return (
    <div>
      {!mini && (
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
        </div>
      )}
      {!hasMetric ? (
        <div className="flex items-center justify-center text-xs text-muted-strong" style={{ height }}>
          No {meta.label.toLowerCase()} data captured yet for this range.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={rows} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={meta.fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={meta.color} stopOpacity={0.28} />
                <stop offset="60%" stopColor={meta.color} stopOpacity={0.06} />
                <stop offset="100%" stopColor={meta.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#1a2130" strokeOpacity={0.6} strokeDasharray="2 4" vertical={false} />
            {!mini && (
              <XAxis
                dataKey="label"
                stroke="#5c6878"
                fontSize={10}
                tickLine={false}
                axisLine={false}
                minTickGap={64}
                tickMargin={8}
              />
            )}
            {!mini && (
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
            )}
            <Tooltip
              content={<TrendTooltip metric={metric} />}
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
              activeDot={{ r: 3.5, strokeWidth: 0, fill: meta.color }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
