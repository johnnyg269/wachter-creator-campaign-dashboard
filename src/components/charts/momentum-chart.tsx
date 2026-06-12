"use client";

// Campaign momentum chart — the dashboard's centerpiece. Tells the growth
// story rather than just plotting totals: gradient area clamped to real
// history, a highlighted "now" marker on the latest reading, metric toggle
// (views/engagements/comments), and a tooltip that breaks the total down by
// platform with the gain since the previous snapshot. Gaps stay gaps — a
// missing reading is never drawn as zero.

import { useMemo, useState, useSyncExternalStore } from "react";
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
import type { ChartRange } from "@/lib/range";
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

/**
 * Range-adaptive x-axis tick label. Exported for tests.
 *  24h            → "8:51 PM" (times)
 *  7d / 30d       → "Jun 9" (days; full timestamp lives in the tooltip)
 *  all            → adapts to the real span: times under ~2 days, else days
 */
export function tickLabel(iso: string, range: ChartRange, spanMs: number): string {
  const d = new Date(iso);
  const useTime = range === "24h" || (range === "all" && spanMs <= 48 * 3_600_000);
  if (useTime) {
    return d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
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
    <div className="min-w-[180px] rounded-xl border border-border-strong bg-surface-raised/95 px-3.5 py-3 text-xs shadow-2xl backdrop-blur-sm">
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
  height = 340,
  range = "7d",
}: {
  data: TrendPoint[];
  byPlatform: Partial<Record<Platform, TrendPoint[]>>;
  height?: number;
  range?: ChartRange;
}) {
  const [metric, setMetric] = useState<Metric>("views");
  const reducedMotion = useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const rows = useMemo(() => buildRows(data, byPlatform), [data, byPlatform]);
  const meta = METRIC_META[metric];
  const withData = rows.filter((r) => r[metric] !== null);
  const last = withData[withData.length - 1] ?? null;
  const hasMetric = withData.length > 0;
  const spanMs =
    rows.length >= 2
      ? new Date(rows[rows.length - 1].t).getTime() - new Date(rows[0].t).getTime()
      : 0;
  // Largest single jump for the current metric — annotated on the line.
  const biggestJump = useMemo(() => {
    let best: Row | null = null;
    for (const r of rows) {
      const g = r.gained[metric];
      if (g !== null && g > 0 && (!best || g > (best.gained[metric] as number))) best = r;
    }
    return best && (best.gained[metric] as number) > 0 ? best : null;
  }, [rows, metric]);
  const timeTicks = range === "24h" || (range === "all" && spanMs <= 48 * 3_600_000);
  // Day-label mode: one tick per calendar day, never "Jun 11" repeated.
  const dayTicks = useMemo(() => {
    if (timeTicks) return undefined;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const r of rows) {
      const day = new Date(r.t).toDateString();
      if (!seen.has(day)) {
        seen.add(day);
        out.push(r.t);
      }
    }
    return out;
  }, [rows, timeTicks]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-0.5 rounded-full border border-border bg-background/60 p-1">
          {(Object.keys(METRIC_META) as Metric[]).map((m) => (
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
                <stop offset="0%" stopColor={meta.color} stopOpacity={0.34} />
                <stop offset="45%" stopColor={meta.color} stopOpacity={0.1} />
                <stop offset="100%" stopColor={meta.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="#1a2130"
              strokeOpacity={0.35}
              strokeDasharray="1 8"
              vertical={false}
            />
            <XAxis
              dataKey="t"
              ticks={dayTicks}
              tickFormatter={(t: string) => tickLabel(t, range, spanMs)}
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
            {/* Soft glow duplicate under the real line — pure presentation */}
            {!reducedMotion && (
              <Area
                type="monotone"
                dataKey={metric}
                stroke={meta.color}
                strokeWidth={5}
                fill="none"
                connectNulls={false}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                className="chart-glow"
                tooltipType="none"
              />
            )}
            <Area
              type="monotone"
              dataKey={metric}
              stroke={meta.color}
              strokeWidth={2.5}
              fill={`url(#${meta.fillId})`}
              connectNulls={false}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0, fill: meta.color }}
              isAnimationActive={!reducedMotion}
              animationDuration={900}
            />
            {biggestJump && biggestJump.t !== last?.t && biggestJump[metric] !== null && (
              <ReferenceDot
                x={biggestJump.t}
                y={biggestJump[metric] as number}
                r={3.5}
                fill="var(--background)"
                stroke={meta.color}
                strokeWidth={1.5}
                label={{
                  value: `+${formatCompact(biggestJump.gained[metric])}`,
                  position: "top",
                  fill: "#8b97a8",
                  fontSize: 10,
                }}
              />
            )}
            {last && last[metric] !== null && (
              <ReferenceDot
                x={last.t}
                y={last[metric] as number}
                r={5}
                fill={meta.color}
                stroke="var(--background)"
                strokeWidth={2.5}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
