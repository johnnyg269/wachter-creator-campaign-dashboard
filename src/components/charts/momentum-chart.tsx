"use client";

// Campaign momentum chart — Phase 3.8.
//
// Default view shows PLATFORM CONTRIBUTION: soft stacked platform areas sit
// beneath the dominant cumulative total line, so "who drove the growth" is
// visible without opening any menu. A Total/Velocity mode toggle switches
// between cumulative totals and per-interval growth (stacked platform bars
// of real snapshot deltas — nothing smoothed, nothing invented). Up to two
// surge annotations mark the biggest real jumps, attributed to the platform
// that caused them. Gaps stay gaps — a missing reading is never drawn as 0.

import { useMemo, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint } from "@/lib/metrics";
import type { ChartRange } from "@/lib/range";
import type { Platform } from "@/lib/types";
import { PLATFORM_LABELS, PLATFORMS } from "@/lib/types";
import { formatCompact, formatDelta } from "@/lib/format";
import { AnimatedText } from "@/components/ui/animated-text";
import { SlidingTabs } from "@/components/ui/sliding-tabs";

type Metric = "views" | "engagements" | "comments";
type ChartMode = "total" | "velocity";

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
  gainedByPlatform: Partial<Record<Platform, Record<Metric, number | null>>>;
  // Flattened keys for Recharts stacking, e.g. p_tiktok_views / g_tiktok_views.
  [flat: string]: unknown;
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

const METRICS: Metric[] = ["views", "engagements", "comments"];

function buildRows(
  data: TrendPoint[],
  byPlatform: Partial<Record<Platform, TrendPoint[]>>,
  estimated?: TrendPoint[],
): Row[] {
  const prev: Record<Metric, number | null> = { views: null, engagements: null, comments: null };
  const prevPlatform = new Map<Platform, Record<Metric, number | null>>();
  return data.map((p, i) => {
    const est = estimated?.[i];
    const gained: Record<Metric, number | null> = { views: null, engagements: null, comments: null };
    for (const m of METRICS) {
      const v = p[m];
      if (v !== null && prev[m] !== null) gained[m] = v - (prev[m] as number);
      if (v !== null) prev[m] = v;
    }
    const rowPlatforms: Row["byPlatform"] = {};
    const rowGains: Row["gainedByPlatform"] = {};
    const flat: Record<string, number | null> = {};
    for (const [platform, series] of Object.entries(byPlatform) as Array<
      [Platform, TrendPoint[]]
    >) {
      const pt = series[i];
      if (!pt) continue;
      const vals: Record<Metric, number | null> = {
        views: pt.views,
        engagements: pt.engagements,
        comments: pt.comments,
      };
      rowPlatforms[platform] = vals;
      const prevP =
        prevPlatform.get(platform) ?? { views: null, engagements: null, comments: null };
      const gains: Record<Metric, number | null> = {
        views: null,
        engagements: null,
        comments: null,
      };
      for (const m of METRICS) {
        const v = vals[m];
        if (v !== null && prevP[m] !== null) gains[m] = v - (prevP[m] as number);
        if (v !== null) prevP[m] = v;
        flat[`p_${platform}_${m}`] = v;
        // Velocity bars: only positive real deltas plot (a null stays a gap).
        flat[`g_${platform}_${m}`] =
          gains[m] !== null && (gains[m] as number) > 0 ? gains[m] : null;
      }
      prevPlatform.set(platform, prevP);
      rowGains[platform] = gains;
    }
    // Display-only estimated overlay (one key per metric); null when no estimate.
    if (est) {
      for (const m of METRICS) flat[`e_${m}`] = est[m];
    }
    return {
      t: p.t,
      label: shortTime(p.t),
      views: p.views,
      engagements: p.engagements,
      comments: p.comments,
      gained,
      byPlatform: rowPlatforms,
      gainedByPlatform: rowGains,
      ...flat,
    };
  });
}

/** Top contributing platform for a row's interval gain (real deltas only). */
function topContributor(row: Row, metric: Metric): { platform: Platform; gained: number } | null {
  let best: { platform: Platform; gained: number } | null = null;
  for (const [platform, gains] of Object.entries(row.gainedByPlatform) as Array<
    [Platform, Record<Metric, number | null>]
  >) {
    const g = gains[metric];
    if (g !== null && g > 0 && (!best || g > best.gained)) best = { platform, gained: g };
  }
  return best;
}

function MomentumTooltip({
  active,
  payload,
  metric,
  mode,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Row }>;
  metric: Metric;
  mode: ChartMode;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const value = row[metric] as number | null;
  const gained = row.gained[metric];
  const top = topContributor(row, metric);
  const platformRows = (
    Object.entries(row.byPlatform) as Array<[Platform, Record<Metric, number | null>]>
  )
    .map(([platform, vals]) => ({
      platform,
      value: vals[metric],
      gain: row.gainedByPlatform[platform]?.[metric] ?? null,
    }))
    .filter((b) => b.value !== null || b.gain !== null)
    .sort((a, b) => (b.gain ?? 0) - (a.gain ?? 0) || (b.value ?? 0) - (a.value ?? 0));
  const intervalTotalGain = platformRows.reduce((s, b) => s + Math.max(0, b.gain ?? 0), 0);

  return (
    <div className="min-w-[210px] rounded-xl border border-border-strong bg-surface-raised/95 px-3.5 py-3 text-xs shadow-2xl backdrop-blur-sm">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">
        {row.label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="tabular-nums text-base font-semibold leading-none">
          {mode === "velocity"
            ? gained !== null
              ? formatDelta(gained)
              : "—"
            : formatCompact(value)}
        </span>
        <span className="text-muted">
          {METRIC_META[metric].label.toLowerCase()}
          {mode === "velocity" ? " this interval" : ""}
        </span>
        {mode === "total" && gained !== null && gained !== 0 && (
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
      {platformRows.length > 0 && (
        <div className="mt-2.5 space-y-1 border-t border-border pt-2">
          {platformRows.map((b) => {
            const isTop = top !== null && b.platform === top.platform && (b.gain ?? 0) > 0;
            const sharePct =
              intervalTotalGain > 0 && b.gain !== null && b.gain > 0
                ? Math.round((b.gain / intervalTotalGain) * 100)
                : null;
            return (
              <div key={b.platform} className="flex items-center justify-between gap-3">
                <span
                  className={clsx(
                    "flex items-center gap-1.5",
                    isTop ? "font-semibold text-foreground" : "text-muted",
                  )}
                >
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: PLATFORM_COLORS[b.platform] }}
                  />
                  {PLATFORM_LABELS[b.platform]}
                </span>
                <span className="tabular-nums">
                  {formatCompact(b.value)}
                  {b.gain !== null && b.gain > 0 && (
                    <span className="ml-1.5 text-positive">
                      {formatDelta(b.gain)}
                      {sharePct !== null && sharePct < 100 && (
                        <span className="text-muted-strong"> ({sharePct}%)</span>
                      )}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          {top && intervalTotalGain > 0 && (
            <div className="pt-1 text-[10px] text-muted-strong">
              {PLATFORM_LABELS[top.platform]} drove this interval
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Surge annotations: up to 2 biggest interval jumps for the current metric,
 * excluding the latest point (the Now marker owns that). A jump qualifies
 * only when it's at least 1.5× the average positive step — meaningful, not
 * noise. Attributed to a platform when one caused >50% of the jump.
 * Exported for tests.
 */
export function findSurges(
  rows: Array<Pick<Row, "t" | "gained" | "gainedByPlatform">>,
  metric: Metric,
  lastT: string | null,
): Array<{ t: string; label: string }> {
  const positive = rows
    .map((r) => r.gained[metric])
    .filter((g): g is number => g !== null && g > 0);
  if (positive.length < 3) return [];
  const avg = positive.reduce((a, b) => a + b, 0) / positive.length;
  return rows
    .filter((r) => {
      const g = r.gained[metric];
      return g !== null && g >= avg * 1.5 && r.t !== lastT;
    })
    .sort((a, b) => (b.gained[metric] as number) - (a.gained[metric] as number))
    .slice(0, 2)
    .map((row) => {
      const g = row.gained[metric] as number;
      const top = topContributor(row as Row, metric);
      const attributed = top !== null && top.gained / g > 0.5;
      return {
        t: row.t,
        label: attributed
          ? `+${formatCompact(g)} · ${PLATFORM_LABELS[top.platform]} spike`
          : `+${formatCompact(g)} surge`,
      };
    });
}

export function MomentumChart({
  data,
  byPlatform,
  estimatedData,
  estimatedUntil = null,
  height = 340,
  range = "7d",
}: {
  data: TrendPoint[];
  byPlatform: Partial<Record<Platform, TrendPoint[]>>;
  /** DISPLAY-ONLY estimated history overlay (Bootcamp ramps from publish date).
   *  Same length/buckets as `data`. Rendered as a dashed line; never affects KPIs. */
  estimatedData?: TrendPoint[];
  /** ISO before which the overlay is estimated (for the footnote). */
  estimatedUntil?: string | null;
  height?: number;
  range?: ChartRange;
}) {
  const [metric, setMetric] = useState<Metric>("views");
  const [mode, setMode] = useState<ChartMode>("total");
  const reducedMotion = useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const rows = useMemo(() => buildRows(data, byPlatform, estimatedData), [data, byPlatform, estimatedData]);
  const meta = METRIC_META[metric];
  // Estimated overlay shows only in Total mode and only when, for the active
  // metric, the estimated series VISIBLY differs from the real line somewhere in
  // the window (a genuine ramp to draw). Avoids a redundant dashed line drawn
  // exactly on top of the solid line on ranges that are already fully tracked.
  const hasEstimated =
    Boolean(estimatedData?.length) &&
    mode === "total" &&
    rows.some((r) => r[`e_${metric}`] != null && r[`e_${metric}`] !== r[metric]);
  const withData = rows.filter((r) => r[metric] !== null);
  const last = withData[withData.length - 1] ?? null;
  const hasMetric = withData.length > 0;
  const spanMs =
    rows.length >= 2
      ? new Date(rows[rows.length - 1].t).getTime() - new Date(rows[0].t).getTime()
      : 0;
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

  const surges = useMemo(
    () => (mode === "total" ? findSurges(rows, metric, last?.t ?? null) : []),
    [rows, metric, mode, last],
  );
  const rowByT = useMemo(() => new Map(rows.map((r) => [r.t, r])), [rows]);
  const platformsPresent = PLATFORMS.filter((p) => byPlatform[p]);
  const velocityHasData = rows.some((r) =>
    platformsPresent.some((p) => (r[`g_${p}_${metric}`] as number | null) !== null),
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SlidingTabs
            ariaLabel="Metric"
            value={metric}
            onChange={setMetric}
            items={(Object.keys(METRIC_META) as Metric[]).map((m) => ({
              value: m,
              ariaLabel: METRIC_META[m].label,
              label: (
                <>
                  <span
                    className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                    style={{ background: METRIC_META[m].color }}
                  />
                  {METRIC_META[m].label}
                </>
              ),
            }))}
          />
          <SlidingTabs
            ariaLabel="Chart mode"
            value={mode}
            onChange={setMode}
            tabClassName="capitalize"
            items={(["total", "velocity"] as ChartMode[]).map((m) => ({
              value: m,
              label: m,
              title:
                m === "total"
                  ? "Cumulative totals over time"
                  : "Growth per interval — is momentum accelerating?",
            }))}
          />
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
            <AnimatedText
              className="tabular-nums font-semibold text-foreground"
              text={formatCompact(last[metric] as number | null)}
            />
            <AnimatedText text={meta.label.toLowerCase()} />
          </div>
        )}
      </div>

      {!hasMetric || (mode === "velocity" && !velocityHasData) ? (
        <div
          className="flex items-center justify-center px-6 text-center text-xs text-muted-strong"
          style={{ height }}
        >
          {mode === "velocity"
            ? "Velocity needs at least two readings per platform — interval growth will appear after the next refreshes."
            : `No ${meta.label.toLowerCase()} data captured yet for this range.`}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={rows} margin={{ top: 18, right: 14, bottom: 0, left: 0 }}>
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
              content={<MomentumTooltip metric={metric} mode={mode} />}
              cursor={{ stroke: "#2a3447", strokeWidth: 1, strokeDasharray: "3 3" }}
            />

            {mode === "total" && [
              // Platform contribution: soft stacked bands under the line.
              // The stack reveals slightly after the total line draws.
              ...platformsPresent.map((p) => (
                <Area
                  key={`stack-${p}`}
                  type="monotone"
                  stackId="platforms"
                  dataKey={`p_${p}_${metric}`}
                  stroke={PLATFORM_COLORS[p]}
                  strokeOpacity={0.35}
                  strokeWidth={1}
                  fill={PLATFORM_COLORS[p]}
                  fillOpacity={0.16}
                  connectNulls={false}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={!reducedMotion}
                  animationDuration={700}
                  animationBegin={reducedMotion ? 0 : 500}
                />
              )),
              // Display-only estimated history: dashed line ramping each Bootcamp
              // video from its publish date. Equals the real line once tracking
              // begins, so it sits under the solid line on the right. tooltipType
              // none so it never adds a phantom entry.
              hasEstimated && (
                <Area
                  key="estimated"
                  type="monotone"
                  dataKey={`e_${metric}`}
                  stroke={meta.color}
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  strokeOpacity={0.55}
                  fill="none"
                  connectNulls
                  dot={false}
                  activeDot={false}
                  isAnimationActive={!reducedMotion}
                  animationDuration={900}
                  tooltipType="none"
                />
              ),
              !reducedMotion && (
                <Area
                  key="glow"
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
              ),
              <Area
                key="total"
                type="monotone"
                dataKey={metric}
                stroke={meta.color}
                strokeWidth={2.5}
                fill="none"
                connectNulls={false}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0, fill: meta.color }}
                isAnimationActive={!reducedMotion}
                animationDuration={900}
              />,
              ...surges.map((s) => {
                const row = rowByT.get(s.t);
                if (!row || row[metric] === null) return null;
                return (
                  <ReferenceDot
                    key={`surge-${s.t}`}
                    x={s.t}
                    y={row[metric] as number}
                    r={3.5}
                    fill="var(--background)"
                    stroke={meta.color}
                    strokeWidth={1.5}
                    label={{ value: s.label, position: "top", fill: "#8b97a8", fontSize: 10 }}
                  />
                );
              }),
              last && last[metric] !== null && (
                <ReferenceDot
                  key="now"
                  x={last.t}
                  y={last[metric] as number}
                  r={5}
                  fill={meta.color}
                  stroke="var(--background)"
                  strokeWidth={2.5}
                />
              ),
            ]}
            {mode === "velocity" &&
              platformsPresent.map((p) => (
                <Bar
                  key={`vel-${p}`}
                  stackId="gains"
                  dataKey={`g_${p}_${metric}`}
                  fill={PLATFORM_COLORS[p]}
                  fillOpacity={0.75}
                  isAnimationActive={!reducedMotion}
                  animationDuration={700}
                />
              ))}
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Platform legend — always visible so the bands explain themselves */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
        {platformsPresent.map((p) => (
          <span key={p} className="flex items-center gap-1.5 text-[10px] text-muted-strong">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: PLATFORM_COLORS[p] }}
            />
            {PLATFORM_LABELS[p]}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-muted-strong">
          {mode === "total"
            ? "Bands show each platform’s share of the total"
            : "Bars show real growth per interval by platform"}
        </span>
      </div>
      {hasEstimated && (
        <p className="mt-1.5 flex items-center gap-1.5 px-1 text-[10px] text-muted-strong">
          <span aria-hidden className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: meta.color, opacity: 0.6 }} />
          Dashed = estimated Bootcamp history
          {estimatedUntil ? ` before Bootcamp tracking began (~${new Date(estimatedUntil).toLocaleDateString("en-US", { month: "short", day: "numeric" })})` : ""}
          , interpolated from publish dates &amp; current totals. Current totals and future growth are actual.
        </p>
      )}
    </div>
  );
}
