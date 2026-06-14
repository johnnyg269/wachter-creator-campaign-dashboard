"use client";

// Reports studio: filter bar (OUTSIDE the slide), a fixed 1280×720 16:9 slide
// canvas scaled to fit (screenshot target 1920×1080), plus Print / Save-PDF and
// Presentation modes. Read-only — it renders the server-supplied public payload
// and re-filters it CLIENT-SIDE with the pure helpers in lib/reports. No
// fetches, no mutations, no secrets, no actor IDs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Printer, Projector, X, ChevronLeft, ChevronRight } from "lucide-react";
import { formatCompact, formatDate, formatNumber, formatPct } from "@/lib/format";
import { PLATFORM_HEX } from "@/components/ui/platform";
import { PLATFORM_LABELS, type Platform } from "@/lib/types";
import {
  DEFAULT_FILTERS,
  METRIC_FOCUSES,
  REPORT_TYPES,
  filterComments,
  filterVideos,
  metricLabel,
  metricValue,
  rankVideos,
  rollupByPlatform,
  rollupComments,
  rollupConcepts,
  rollupVideos,
  type MetricFocus,
  type ReportFilters,
  type ReportType,
  type ReportsData,
  type ReportTrendPoint,
} from "@/lib/reports";
import type { TimeRange } from "@/lib/queries";

const CANVAS_W = 1280;
const CANVAS_H = 720;

const RANGES: Array<{ value: TimeRange; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

function fmtMetric(value: number | null, metric: MetricFocus): string {
  if (value === null) return "—";
  return metric === "engagement" ? formatPct(value) : formatCompact(value);
}

// ── Filter controls ─────────────────────────────────────────────────────────

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">{label}</span>
      <div className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={o.value === value}
            className={
              o.value === value
                ? "rounded-md bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-medium text-foreground"
                : "rounded-md px-2.5 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-[30px] rounded-lg border border-border bg-surface px-2.5 text-[12px] font-medium text-foreground outline-none transition-colors hover:border-border-strong focus:border-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── Slide primitives (rendered at 1280×720 design size) ─────────────────────

function ConfidenceChip({ level, label }: { level: "high" | "partial" | "building"; label: string }) {
  const color =
    level === "high" ? "var(--positive)" : level === "partial" ? "var(--warning)" : "var(--muted-strong)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium"
      style={{ borderColor: "var(--border-strong)", color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function SlideFrame({
  data,
  title,
  subtitle,
  children,
}: {
  data: ReportsData;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const { meta, confidence } = data;
  return (
    <div className="flex h-full w-full flex-col px-14 py-12" style={{ color: "var(--foreground)" }}>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-[13px] font-medium uppercase tracking-[0.18em] text-muted">
            {meta.creatorName} <span className="text-muted-strong">×</span> {meta.company}
          </div>
          <h1 className="mt-1.5 text-[40px] font-semibold leading-none tracking-tight">{title}</h1>
          <p className="mt-2 text-[15px] text-muted">{subtitle}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 text-right">
          <ConfidenceChip level={confidence.level} label={confidence.headline} />
          <div className="text-[12px] text-muted">
            {meta.rangeLabel}
            {meta.dateFrom && (
              <>
                {" · "}
                {formatDate(meta.dateFrom)} – {formatDate(meta.dateTo)}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mt-7 min-h-0 flex-1">{children}</div>

      {/* Footer */}
      <div className="mt-6 flex items-center justify-between border-t pt-3 text-[11px] text-muted-strong" style={{ borderColor: "var(--border)" }}>
        <span>{meta.campaignName} — real-time campaign analytics</span>
        <span>Generated {formatDate(meta.generatedAt)}</span>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-2xl border px-6 py-5"
      style={{
        borderColor: highlight ? "var(--accent)" : "var(--border)",
        background: highlight ? "var(--accent-soft)" : "var(--surface)",
      }}
    >
      <div className="text-[12px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular mt-2 text-[38px] font-semibold leading-none tracking-tight">{value}</div>
      {sub && <div className="mt-2 text-[12px] text-muted">{sub}</div>}
    </div>
  );
}

/** Horizontal bar row used by the platform / concept comparisons. */
function BarRow({
  label,
  valueText,
  fraction,
  color,
  metaText,
}: {
  label: React.ReactNode;
  valueText: string;
  fraction: number;
  color: string;
  metaText?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-[14px] font-medium">{label}</span>
        <span className="tabular shrink-0 text-[14px] font-semibold">{valueText}</span>
      </div>
      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-hover)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%`, background: color }}
        />
      </div>
      {metaText && <div className="mt-1 text-[11px] text-muted-strong">{metaText}</div>}
    </div>
  );
}

function PlatformLabel({ platform }: { platform: Platform }) {
  return (
    <>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: PLATFORM_HEX[platform] }} />
      <span className="truncate">{PLATFORM_LABELS[platform]}</span>
    </>
  );
}

/** Compact SVG area+line trend (real points only; scales with the canvas). */
function MiniTrend({ points, color = "#3b82f6" }: { points: ReportTrendPoint[]; color?: string }) {
  const vals = points.map((p) => p.views);
  const real = vals.filter((v): v is number => v !== null);
  if (real.length < 3) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-strong">
        Not enough history yet for a trend line
      </div>
    );
  }
  const w = 560;
  const h = 150;
  const pad = 6;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min || 1;
  // Index across all buckets, but only plot the real readings (no fake zeros).
  const realIdx = vals.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  const n = realIdx.length;
  const stepX = (w - pad * 2) / (n - 1);
  const coords = realIdx.map(([, v], i) => {
    const x = pad + i * stepX;
    const y = pad + (h - pad * 2) - ((v - min) / span) * (h - pad * 2);
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${h - pad} L${coords[0][0].toFixed(1)},${h - pad} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none" role="img" aria-label="Views trend">
      <defs>
        <linearGradient id="reportTrendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#reportTrendGrad)" stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function EmptySlideNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center rounded-2xl border border-dashed text-[15px] text-muted" style={{ borderColor: "var(--border-strong)" }}>
      {children}
    </div>
  );
}

// ── Report slides ────────────────────────────────────────────────────────────

function ExecutiveSlide({ data, f }: { data: ReportsData; f: ReportFilters }) {
  const vids = filterVideos(data.videos, f);
  const roll = rollupVideos(vids);
  const comments = rollupComments(filterComments(data.comments, f));
  const top = rankVideos(vids, f.metric).slice(0, 5);
  const platRolls = rollupByPlatform(vids);
  const concepts = rollupConcepts(vids, data.concepts);
  const bestConcept = [...concepts].sort(
    (a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1),
  )[0];

  return (
    <div className="flex h-full flex-col gap-6">
      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard label="Total views" value={formatCompact(roll.totalViews)} sub={`${formatNumber(roll.count)} videos tracked`} highlight={f.metric === "views"} />
        <KpiCard label="Engagement rate" value={formatPct(roll.engagementRate)} sub={`${formatCompact(roll.totalEngagements)} engagements`} highlight={f.metric === "engagement"} />
        <KpiCard label="Comments" value={formatCompact(roll.totalComments)} sub={`${formatNumber(comments.needsResponse)} need a response`} highlight={f.metric === "comments"} />
        <KpiCard label={`Growth · ${data.meta.rangeLabel}`} value={roll.totalGrowth === null ? "—" : `+${formatCompact(roll.totalGrowth)}`} sub="views gained in range" highlight={f.metric === "growth"} />
      </div>

      {/* Two columns */}
      <div className="grid min-h-0 flex-1 grid-cols-[1.25fr_1fr] gap-5">
        {/* Left column: views trend + top performers */}
        <div className="flex min-h-0 flex-col gap-5">
          <div className="rounded-2xl border px-6 pb-3 pt-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <div className="flex items-baseline justify-between">
              <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Views over time</div>
              <div className="tabular text-[12px] text-muted">{data.meta.rangeLabel}</div>
            </div>
            <div className="mt-2 h-[120px]">
              <MiniTrend points={data.overallTrend} />
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col rounded-2xl border px-6 py-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Top performers · {metricLabel(f.metric)}</div>
            {top.length === 0 ? (
              <div className="mt-4 text-[14px] text-muted">No confirmed {metricLabel(f.metric).toLowerCase()} data in this view yet.</div>
            ) : (
              <div className="mt-4 flex flex-col gap-3">
                {top.slice(0, 4).map((v, i) => (
                  <div key={v.id} className="flex items-center gap-3">
                    <span className="tabular w-5 shrink-0 text-[15px] font-semibold text-muted-strong">{i + 1}</span>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_HEX[v.platform] }} />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{v.title}</span>
                    <span className="tabular shrink-0 text-[15px] font-semibold">{fmtMetric(metricValue(v, f.metric), f.metric)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column: platform mix + audience snapshot */}
        <div className="flex min-h-0 flex-col gap-5">
          <div className="flex-1 rounded-2xl border px-6 py-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Platform mix · {metricLabel(f.metric)}</div>
            <div className="mt-4 flex flex-col gap-3.5">
              {platRolls.length === 0 ? (
                <div className="text-[14px] text-muted">No platform data in this view.</div>
              ) : (
                (() => {
                  const metricOf = (r: (typeof platRolls)[number]) =>
                    f.metric === "engagement" ? r.engagementRate : f.metric === "comments" ? r.totalComments : f.metric === "growth" ? r.totalGrowth : r.totalViews;
                  const maxV = Math.max(1, ...platRolls.map((r) => metricOf(r) ?? 0));
                  return [...platRolls]
                    .sort((a, b) => (metricOf(b) ?? -1) - (metricOf(a) ?? -1))
                    .map((r) => (
                      <BarRow
                        key={r.platform}
                        label={<PlatformLabel platform={r.platform} />}
                        valueText={fmtMetric(metricOf(r), f.metric)}
                        fraction={(metricOf(r) ?? 0) / maxV}
                        color={PLATFORM_HEX[r.platform]}
                      />
                    ));
                })()
              )}
            </div>
          </div>

          <div className="rounded-2xl border px-6 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <div className="flex items-center justify-between">
              <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Audience</div>
              {bestConcept && (
                <div className="text-[12px] text-muted">
                  Top concept: <span className="font-medium text-foreground">{bestConcept.name}</span>
                </div>
              )}
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-center">
              <div>
                <div className="tabular text-[24px] font-semibold leading-none">{formatNumber(comments.total)}</div>
                <div className="mt-1 text-[11px] text-muted">comments</div>
              </div>
              <div>
                <div className="tabular text-[24px] font-semibold leading-none" style={{ color: "var(--warning)" }}>{formatNumber(comments.needsResponse)}</div>
                <div className="mt-1 text-[11px] text-muted">need response</div>
              </div>
              <div>
                <div className="tabular text-[24px] font-semibold leading-none" style={{ color: "var(--positive)" }}>{formatNumber(comments.recruiting)}</div>
                <div className="mt-1 text-[11px] text-muted">recruiting interest</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlatformsSlide({ data, f }: { data: ReportsData; f: ReportFilters }) {
  const vids = filterVideos(data.videos, f);
  const rolls = rollupByPlatform(vids);
  const metricOf = (r: (typeof rolls)[number]) =>
    f.metric === "engagement" ? r.engagementRate : f.metric === "comments" ? r.totalComments : f.metric === "growth" ? r.totalGrowth : r.totalViews;
  if (rolls.length === 0) return <EmptySlideNote>No platform data for this filter combination.</EmptySlideNote>;
  const sorted = [...rolls].sort((a, b) => (metricOf(b) ?? -1) - (metricOf(a) ?? -1));
  const maxV = Math.max(1, ...sorted.map((r) => metricOf(r) ?? 0));
  const freshness = new Map(data.platforms.map((p) => [p.platform, p]));

  return (
    <div className="grid h-full grid-cols-[1fr_1fr] gap-6">
      {/* Bars by focus metric */}
      <div className="flex min-h-0 flex-col rounded-2xl border px-7 py-6" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">{metricLabel(f.metric)} by platform</div>
        <div className="mt-6 flex flex-col gap-6">
          {sorted.map((r) => (
            <BarRow
              key={r.platform}
              label={<PlatformLabel platform={r.platform} />}
              valueText={fmtMetric(metricOf(r), f.metric)}
              fraction={(metricOf(r) ?? 0) / maxV}
              color={PLATFORM_HEX[r.platform]}
              metaText={`${formatNumber(r.count)} videos · ${formatCompact(r.totalViews)} views · ${formatPct(r.engagementRate)} ER`}
            />
          ))}
        </div>
      </div>

      {/* Per-platform stat cards */}
      <div className="grid min-h-0 grid-cols-2 gap-4" style={{ gridAutoRows: "1fr" }}>
        {sorted.map((r) => {
          const fr = freshness.get(r.platform);
          return (
            <div key={r.platform} className="flex flex-col rounded-2xl border px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: PLATFORM_HEX[r.platform] }} />
                <span className="text-[15px] font-semibold">{PLATFORM_LABELS[r.platform]}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5">
                <Stat label="Views" value={formatCompact(r.totalViews)} />
                <Stat label="Eng. rate" value={formatPct(r.engagementRate)} />
                <Stat label="Engagements" value={formatCompact(r.totalEngagements)} />
                <Stat label={`Growth · ${data.meta.range}`} value={r.totalGrowth === null ? "—" : `+${formatCompact(r.totalGrowth)}`} />
              </div>
              <div className="mt-auto pt-3 text-[11px] text-muted-strong">
                {fr ? `${fr.freshness === "high" ? "Live" : fr.freshness === "failed" ? "Last refresh failed" : "Last-known-good"}${fr.lastSuccessfulRefreshAt ? ` · ${formatDate(fr.lastSuccessfulRefreshAt)}` : ""}` : ""}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular mt-0.5 text-[17px] font-semibold">{value}</div>
    </div>
  );
}

function ConceptsSlide({ data, f }: { data: ReportsData; f: ReportFilters }) {
  const vids = filterVideos(data.videos, f);
  const rolls = rollupConcepts(vids, data.concepts);
  const metricOf = (r: (typeof rolls)[number]) =>
    f.metric === "engagement" ? r.engagementRate : f.metric === "comments" ? r.totalComments : f.metric === "growth" ? r.totalGrowth : r.totalViews;
  if (rolls.length === 0) return <EmptySlideNote>No content concepts have tracked videos in this view yet.</EmptySlideNote>;
  const sorted = [...rolls].sort((a, b) => (metricOf(b) ?? -1) - (metricOf(a) ?? -1));
  const maxV = Math.max(1, ...sorted.map((r) => metricOf(r) ?? 0));
  const palette = ["#3b82f6", "#34d399", "#e95daa", "#fbbf24", "#25f4ee", "#a78bfa", "#fb923c", "#4b8dff"];

  return (
    <div className="flex h-full flex-col rounded-2xl border px-8 py-6" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Content concepts · ranked by {metricLabel(f.metric).toLowerCase()}</div>
        <div className="text-[12px] text-muted">{formatNumber(sorted.length)} concepts</div>
      </div>
      <div className="mt-5 flex min-h-0 flex-1 flex-col justify-between gap-3.5">
        {sorted.slice(0, 7).map((r, i) => (
          <div key={r.id} className="flex items-center gap-4">
            <span className="tabular w-5 shrink-0 text-[15px] font-semibold text-muted-strong">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <BarRow
                label={<span className="truncate">{r.name}</span>}
                valueText={fmtMetric(metricOf(r), f.metric)}
                fraction={(metricOf(r) ?? 0) / maxV}
                color={palette[i % palette.length]}
                metaText={`${formatNumber(r.count)} videos · ${formatCompact(r.totalViews)} views · ${formatPct(r.engagementRate)} ER · ${formatCompact(r.totalComments)} comments`}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AudienceSlide({ data, f }: { data: ReportsData; f: ReportFilters }) {
  const comments = filterComments(data.comments, f);
  const c = rollupComments(comments);
  const vids = filterVideos(data.videos, f);
  if (c.total === 0) return <EmptySlideNote>No comments captured for this filter combination yet.</EmptySlideNote>;
  const sentiments: Array<{ key: string; label: string; value: number; color: string }> = [
    { key: "positive", label: "Positive", value: c.positive, color: "var(--positive)" },
    { key: "question", label: "Questions", value: c.questions, color: "var(--accent)" },
    { key: "neutral", label: "Neutral", value: c.neutral, color: "var(--muted-strong)" },
    { key: "negative", label: "Negative", value: c.negative, color: "var(--negative)" },
  ];
  const maxSent = Math.max(1, ...sentiments.map((s) => s.value));
  // Per-platform comment volume within the current filter.
  const byPlatform = (Object.keys(PLATFORM_LABELS) as Platform[])
    .map((p) => ({ platform: p, count: comments.filter((x) => x.platform === p).length }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const maxPlat = Math.max(1, ...byPlatform.map((x) => x.count));
  const needsResponseVideos = [...vids]
    .filter((v) => v.audienceNeedsResponse > 0)
    .sort((a, b) => b.audienceNeedsResponse - a.audienceNeedsResponse)
    .slice(0, 4);

  return (
    <div className="grid h-full grid-cols-[1fr_1fr] gap-6">
      {/* Sentiment + signals */}
      <div className="flex min-h-0 flex-col gap-5">
        <div className="rounded-2xl border px-6 py-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="flex items-baseline justify-between">
            <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Sentiment mix</div>
            <div className="tabular text-[13px] text-muted">{formatNumber(c.total)} comments</div>
          </div>
          <div className="mt-4 flex flex-col gap-3.5">
            {sentiments.map((s) => (
              <BarRow
                key={s.key}
                label={<span>{s.label}</span>}
                valueText={`${formatNumber(s.value)} · ${formatPct(c.total ? s.value / c.total : null)}`}
                fraction={s.value / maxSent}
                color={s.color}
              />
            ))}
          </div>
        </div>
        <div className="grid flex-1 grid-cols-3 gap-4">
          <SignalCard label="Need response" value={c.needsResponse} accent="var(--warning)" />
          <SignalCard label="Recruiting interest" value={c.recruiting} accent="var(--positive)" />
          <SignalCard label="Wachter mentions" value={c.wachter} accent="var(--accent)" />
        </div>
      </div>

      {/* Volume by platform + response hot spots */}
      <div className="flex min-h-0 flex-col gap-5">
        <div className="rounded-2xl border px-6 py-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Comment volume by platform</div>
          <div className="mt-4 flex flex-col gap-3.5">
            {byPlatform.map((x) => (
              <BarRow
                key={x.platform}
                label={<PlatformLabel platform={x.platform} />}
                valueText={formatNumber(x.count)}
                fraction={x.count / maxPlat}
                color={PLATFORM_HEX[x.platform]}
              />
            ))}
          </div>
        </div>
        <div className="flex-1 rounded-2xl border px-6 py-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Response hot spots</div>
          {needsResponseVideos.length === 0 ? (
            <div className="mt-3 text-[14px] text-muted">No open questions awaiting a response. 🎉</div>
          ) : (
            <div className="mt-3 flex flex-col gap-2.5">
              {needsResponseVideos.map((v) => (
                <div key={v.id} className="flex items-center gap-3">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_HEX[v.platform] }} />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{v.title}</span>
                  <span className="tabular shrink-0 text-[14px] font-semibold" style={{ color: "var(--warning)" }}>
                    {formatNumber(v.audienceNeedsResponse)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SignalCard({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="flex flex-col justify-center rounded-2xl border px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="tabular text-[34px] font-semibold leading-none" style={{ color: accent }}>{formatNumber(value)}</div>
      <div className="mt-2 text-[12px] text-muted">{label}</div>
    </div>
  );
}

const SLIDE_SUBTITLE: Record<ReportType, string> = {
  executive: "Campaign performance at a glance",
  platforms: "Side-by-side performance across networks",
  concepts: "Which content concepts are working",
  audience: "What the audience is telling us",
};

function Slide({ data, f }: { data: ReportsData; f: ReportFilters }) {
  const title = REPORT_TYPES.find((t) => t.value === f.type)?.label ?? "Report";
  const scope =
    f.platform === "all" ? "" : ` · ${PLATFORM_LABELS[f.platform]}`;
  const conceptName =
    f.conceptId === "all" ? "" : ` · ${data.concepts.find((c) => c.id === f.conceptId)?.name ?? "Concept"}`;
  return (
    <SlideFrame data={data} title={title} subtitle={`${SLIDE_SUBTITLE[f.type]}${scope}${conceptName}`}>
      {f.type === "executive" && <ExecutiveSlide data={data} f={f} />}
      {f.type === "platforms" && <PlatformsSlide data={data} f={f} />}
      {f.type === "concepts" && <ConceptsSlide data={data} f={f} />}
      {f.type === "audience" && <AudienceSlide data={data} f={f} />}
    </SlideFrame>
  );
}

// ── Studio shell ─────────────────────────────────────────────────────────────

export function ReportsStudio({
  data,
  initialFilters,
}: {
  data: ReportsData;
  initialFilters: ReportFilters;
}) {
  const router = useRouter();
  const [platform, setPlatform] = useState(initialFilters.platform);
  const [conceptId, setConceptId] = useState(initialFilters.conceptId);
  const [metric, setMetric] = useState<MetricFocus>(initialFilters.metric);
  const [type, setType] = useState<ReportType>(initialFilters.type);
  const [presenting, setPresenting] = useState(false);

  const range = data.meta.range; // server-driven

  const filters: ReportFilters = useMemo(
    () => ({ range, platform, conceptId, metric, type }),
    [range, platform, conceptId, metric, type],
  );

  // Mirror the four client filters into the URL WITHOUT a server round-trip, so
  // the view is shareable and a range navigation preserves them.
  useEffect(() => {
    const p = new URLSearchParams();
    p.set("range", range);
    if (platform !== "all") p.set("platform", platform);
    if (conceptId !== "all") p.set("concept", conceptId);
    if (metric !== DEFAULT_FILTERS.metric) p.set("metric", metric);
    if (type !== DEFAULT_FILTERS.type) p.set("type", type);
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `/reports?${qs}` : "/reports");
  }, [range, platform, conceptId, metric, type]);

  // Range is the only filter that changes the underlying windowed numbers, so it
  // navigates (server refetch), carrying the current filters along.
  const changeRange = useCallback(
    (next: TimeRange) => {
      const p = new URLSearchParams();
      p.set("range", next);
      if (platform !== "all") p.set("platform", platform);
      if (conceptId !== "all") p.set("concept", conceptId);
      if (metric !== DEFAULT_FILTERS.metric) p.set("metric", metric);
      if (type !== DEFAULT_FILTERS.type) p.set("type", type);
      router.push(`/reports?${p.toString()}`);
    },
    [router, platform, conceptId, metric, type],
  );

  // Canvas scale-to-fit (in-flow studio view).
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.6);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / CANVAS_W));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Presentation scale-to-fit (viewport), recomputed on resize.
  const [presScale, setPresScale] = useState(1);
  useEffect(() => {
    if (!presenting) return;
    const measure = () =>
      setPresScale(Math.min(window.innerWidth / CANVAS_W, window.innerHeight / CANVAS_H) * 0.92);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [presenting]);

  // Presentation keyboard: ←/→ switch report type, Esc exits.
  useEffect(() => {
    if (!presenting) return;
    const order = REPORT_TYPES.map((t) => t.value);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresenting(false);
      else if (e.key === "ArrowRight") setType((t) => order[(order.indexOf(t) + 1) % order.length]);
      else if (e.key === "ArrowLeft") setType((t) => order[(order.indexOf(t) - 1 + order.length) % order.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting]);

  const platformOptions: Array<{ value: Platform | "all"; label: string }> = [
    { value: "all", label: "All platforms" },
    ...(Object.keys(PLATFORM_LABELS) as Platform[]).map((p) => ({ value: p, label: PLATFORM_LABELS[p] })),
  ];
  const conceptOptions: Array<{ value: string; label: string }> = [
    { value: "all", label: "All concepts" },
    ...data.concepts.map((c) => ({ value: c.id, label: c.name })),
  ];

  return (
    <div className="mx-auto w-full max-w-[1320px]">
      {/* Toolbar (OUTSIDE the slide) */}
      <div className="report-no-print mb-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
            <p className="mt-0.5 text-xs text-muted">
              Printable, screenshot-ready campaign reports — 16:9, optimized for 1920×1080.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:border-border-strong"
            >
              <Printer size={14} /> Print / Save PDF
            </button>
            <button
              type="button"
              onClick={() => setPresenting(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
              style={{ borderColor: "var(--accent)", background: "var(--accent)" }}
            >
              <Projector size={14} /> Present
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-x-5 gap-y-3 rounded-xl border border-border bg-surface/60 px-4 py-3">
          <Segmented label="Report" value={type} options={REPORT_TYPES} onChange={setType} />
          <Segmented label="Date range" value={range} options={RANGES} onChange={changeRange} />
          <Dropdown label="Platform" value={platform} options={platformOptions} onChange={setPlatform} />
          <Dropdown label="Content concept" value={conceptId} options={conceptOptions} onChange={setConceptId} />
          <Segmented label="Metric focus" value={metric} options={METRIC_FOCUSES} onChange={setMetric} />
        </div>
      </div>

      {/* Slide canvas (scaled to fit). This wrapper is the print target. */}
      <div ref={wrapRef} className="report-print-root w-full">
        <div style={{ height: CANVAS_H * scale }}>
          <div
            className="report-canvas overflow-hidden rounded-2xl border"
            style={{
              width: CANVAS_W,
              height: CANVAS_H,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
              background: "var(--background)",
              borderColor: "var(--border)",
              boxShadow: "0 24px 64px -24px rgba(0,0,0,0.6)",
            }}
          >
            <Slide data={data} f={filters} />
          </div>
        </div>
      </div>

      <p className="report-no-print mt-4 text-center text-[11px] text-muted-strong">
        Tip: use Present for a full-screen view (← → to switch reports, Esc to exit), or Print / Save PDF for a one-page export.
        Screenshot the slide for a clean 16:9 image.
      </p>

      {/* Presentation overlay */}
      {presenting && (
        <div className="report-no-print fixed inset-0 z-[100] flex items-center justify-center" style={{ background: "rgba(3,5,9,0.97)" }}>
          <button
            type="button"
            onClick={() => setPresenting(false)}
            aria-label="Exit presentation"
            className="absolute right-5 top-5 rounded-lg border border-border bg-surface/80 p-2 text-muted transition-colors hover:text-foreground"
          >
            <X size={18} />
          </button>
          <button
            type="button"
            aria-label="Previous report"
            onClick={() => {
              const order = REPORT_TYPES.map((t) => t.value);
              setType(order[(order.indexOf(type) - 1 + order.length) % order.length]);
            }}
            className="absolute left-5 top-1/2 -translate-y-1/2 rounded-full border border-border bg-surface/80 p-3 text-muted transition-colors hover:text-foreground"
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            aria-label="Next report"
            onClick={() => {
              const order = REPORT_TYPES.map((t) => t.value);
              setType(order[(order.indexOf(type) + 1) % order.length]);
            }}
            className="absolute right-5 top-1/2 -translate-y-1/2 rounded-full border border-border bg-surface/80 p-3 text-muted transition-colors hover:text-foreground"
          >
            <ChevronRight size={22} />
          </button>
          <div style={{ width: CANVAS_W * presScale, height: CANVAS_H * presScale }}>
            <div
              className="overflow-hidden rounded-2xl border"
              style={{
                width: CANVAS_W,
                height: CANVAS_H,
                transform: `scale(${presScale})`,
                transformOrigin: "top left",
                background: "var(--background)",
                borderColor: "var(--border-strong)",
              }}
            >
              <Slide data={data} f={filters} />
            </div>
          </div>
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 text-[12px] text-muted-strong">
            {REPORT_TYPES.find((t) => t.value === type)?.label} · {data.meta.rangeLabel}
          </div>
        </div>
      )}
    </div>
  );
}
