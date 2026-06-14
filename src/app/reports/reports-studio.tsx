"use client";

// Reports studio: filter bar (OUTSIDE the slide), a fixed 1280×720 16:9 slide
// canvas scaled to fit (screenshot target 1920×1080), plus Print / Save-PDF and
// Presentation modes. Read-only — it renders the server-supplied public payload
// and re-filters it CLIENT-SIDE with the pure helpers in lib/reports. No
// fetches, no mutations, no secrets, no actor IDs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Printer, Projector, X, ChevronLeft, ChevronRight } from "lucide-react";
import { formatCompact, formatDate, formatDateTime, formatNumber, formatPct } from "@/lib/format";
import { PLATFORM_HEX } from "@/components/ui/platform";
import { SlidingTabs } from "@/components/ui/sliding-tabs";
import { PLATFORM_LABELS, type Platform } from "@/lib/types";
import {
  DEFAULT_FILTERS,
  METRIC_FOCUSES,
  REPORT_TYPES,
  filterComments,
  filterVideos,
  metricLabel,
  rankVideos,
  rollupByPlatform,
  rollupComments,
  rollupConcepts,
  rollupVideos,
  sumReal,
  type MetricFocus,
  type ReportFilters,
  type ReportType,
  type ReportVideo,
  type ReportsData,
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
      <SlidingTabs
        ariaLabel={label}
        value={value}
        onChange={onChange}
        items={options.map((o) => ({ value: o.value, label: o.label }))}
      />
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
  filtersSummary,
  children,
}: {
  data: ReportsData;
  title: string;
  subtitle: string;
  filtersSummary: string;
  children: React.ReactNode;
}) {
  const { meta, confidence } = data;
  return (
    <div className="flex h-full w-full flex-col px-14 py-10" style={{ color: "var(--foreground)" }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <Image
              src="/branding/wachter-creator-logo.png"
              alt="Wachter Creator"
              width={2584}
              height={358}
              priority
              className="h-7 w-auto object-contain"
            />
          </div>
          <div className="mt-3 text-[12px] font-medium uppercase tracking-[0.22em] text-muted-strong">
            Campaign Report · {meta.creatorName} <span className="text-muted-strong">×</span> {meta.company}
          </div>
          <h1 className="mt-1 text-[38px] font-semibold leading-none tracking-tight">{title}</h1>
          <p className="mt-2 text-[14px] text-muted">{subtitle}</p>
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
          <div className="text-[11px] text-muted-strong">
            {meta.lastSuccessfulRefreshAt
              ? `Last refreshed ${formatDateTime(meta.lastSuccessfulRefreshAt)}`
              : "Awaiting first refresh"}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="mt-6 min-h-0 flex-1">{children}</div>

      {/* Footer */}
      <div className="mt-5 flex items-center justify-between gap-4 border-t pt-3 text-[11px] text-muted-strong" style={{ borderColor: "var(--border)" }}>
        <span>Data from public platform metrics · {filtersSummary}</span>
        <span>Generated {formatDateTime(meta.generatedAt)}</span>
      </div>
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

function EmptySlideNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center rounded-2xl border border-dashed text-[15px] text-muted" style={{ borderColor: "var(--border-strong)" }}>
      {children}
    </div>
  );
}

/** One cell of the compact KPI strip. */
function Kpi({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div
      className="flex flex-col justify-center rounded-xl border px-4 py-3"
      style={{
        borderColor: highlight ? "var(--accent)" : "var(--border)",
        background: highlight ? "var(--accent-soft)" : "var(--surface)",
      }}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular mt-1 text-[26px] font-semibold leading-none tracking-tight">{value}</div>
      {sub && <div className="mt-1 truncate text-[11px] text-muted-strong">{sub}</div>}
    </div>
  );
}

/** Lower-section highlight: a named pick with its metric (and platform dot). */
function HighlightCard({
  label,
  video,
  valueText,
  fallback,
}: {
  label: string;
  video?: ReportVideo | null;
  valueText?: string;
  fallback?: string;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-2xl border px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</div>
      {video ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PLATFORM_HEX[video.platform] }} />
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium leading-snug">{video.title}</span>
          </div>
          {valueText && <div className="tabular mt-auto pt-2 text-[18px] font-semibold">{valueText}</div>}
        </>
      ) : (
        <div className="mt-2 text-[13px] text-muted">{fallback ?? "Not enough data yet"}</div>
      )}
    </div>
  );
}

/** Platform contribution: one stacked horizontal bar of view share + legend. */
function StackedShareBar({ rolls }: { rolls: ReturnType<typeof rollupByPlatform> }) {
  const total = sumReal(rolls.map((r) => r.totalViews)) ?? 0;
  const withViews = rolls.filter((r) => (r.totalViews ?? 0) > 0);
  if (total <= 0 || withViews.length === 0) {
    return <div className="mt-4 text-[14px] text-muted">No confirmed view data to break down yet.</div>;
  }
  const sorted = [...withViews].sort((a, b) => (b.totalViews ?? 0) - (a.totalViews ?? 0));
  return (
    <div className="mt-4">
      <div className="flex h-6 w-full overflow-hidden rounded-full" style={{ background: "var(--surface-hover)" }}>
        {sorted.map((r) => (
          <div
            key={r.platform}
            style={{ width: `${((r.totalViews ?? 0) / total) * 100}%`, background: PLATFORM_HEX[r.platform] }}
            title={`${PLATFORM_LABELS[r.platform]} · ${formatPct((r.totalViews ?? 0) / total)}`}
          />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2.5">
        {sorted.map((r) => (
          <div key={r.platform} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: PLATFORM_HEX[r.platform] }} />
              <span className="truncate">{PLATFORM_LABELS[r.platform]}</span>
            </span>
            <span className="tabular shrink-0 text-[13px]">
              <span className="font-semibold">{formatPct((r.totalViews ?? 0) / total)}</span>
              <span className="text-muted-strong"> · {formatCompact(r.totalViews)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Report slides ────────────────────────────────────────────────────────────

function ExecutiveSlide({ data, f }: { data: ReportsData; f: ReportFilters }) {
  const vids = filterVideos(data.videos, f);
  const roll = rollupVideos(vids);
  const comments = rollupComments(filterComments(data.comments, f));
  const platRolls = rollupByPlatform(vids);
  const concepts = rollupConcepts(vids, data.concepts);
  const topPlatform = [...platRolls].sort((a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1))[0];
  const totalPlatViews = sumReal(platRolls.map((r) => r.totalViews)) ?? 0;
  const topGrowthVideo = rankVideos(vids, "growth")[0] ?? null;
  const topOverallVideo = rankVideos(vids, "views")[0] ?? null;
  const bestConcept = [...concepts].sort((a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1))[0] ?? null;
  const responseVideo = [...vids].filter((v) => v.audienceNeedsResponse > 0).sort((a, b) => b.audienceNeedsResponse - a.audienceNeedsResponse)[0] ?? null;

  return (
    <div className="flex h-full flex-col gap-5">
      {/* KPI strip (7) */}
      <div className="grid grid-cols-7 gap-2.5">
        <Kpi label="Total views" value={formatCompact(roll.totalViews)} highlight={f.metric === "views"} />
        <Kpi label="Views gained" value={roll.totalGrowth === null ? "—" : `+${formatCompact(roll.totalGrowth)}`} sub={data.meta.rangeLabel} highlight={f.metric === "growth"} />
        <Kpi label="Engagements" value={formatCompact(roll.totalEngagements)} highlight={f.metric === "engagement"} />
        <Kpi label="Eng. rate" value={formatPct(roll.engagementRate)} />
        <Kpi label="Comments" value={formatCompact(roll.totalComments)} highlight={f.metric === "comments"} />
        <Kpi
          label="Top platform"
          value={topPlatform ? PLATFORM_LABELS[topPlatform.platform].split(" ")[0] : "—"}
          sub={topPlatform && totalPlatViews > 0 ? `${formatPct((topPlatform.totalViews ?? 0) / totalPlatViews)} of views` : undefined}
        />
        <Kpi label="Videos tracked" value={formatNumber(roll.count)} />
      </div>

      {/* Main visual: platform contribution */}
      <div className="rounded-2xl border px-7 py-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="flex items-baseline justify-between">
          <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Platform contribution · share of views</div>
          <div className="text-[12px] text-muted">{formatCompact(roll.totalViews)} total views</div>
        </div>
        <StackedShareBar rolls={platRolls} />
      </div>

      {/* Lower section: 4 highlights */}
      <div className="grid min-h-0 flex-1 grid-cols-4 gap-4">
        <HighlightCard label="Top growth video" video={topGrowthVideo} valueText={topGrowthVideo ? `+${fmtMetric(topGrowthVideo.periodGrowth, "growth")} views` : undefined} fallback="No range growth yet" />
        <HighlightCard label="Top overall video" video={topOverallVideo} valueText={topOverallVideo ? `${fmtMetric(topOverallVideo.views, "views")} views` : undefined} />
        <div className="flex min-h-0 flex-col rounded-2xl border px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Winning concept</div>
          {bestConcept ? (
            <>
              <div className="mt-2 truncate text-[15px] font-medium">{bestConcept.name}</div>
              <div className="tabular mt-auto pt-2 text-[13px] text-muted-strong">
                {fmtMetric(bestConcept.totalViews, "views")} views · {formatNumber(bestConcept.count)} videos
              </div>
            </>
          ) : (
            <div className="mt-2 text-[13px] text-muted">No concept data yet</div>
          )}
        </div>
        <div className="flex min-h-0 flex-col rounded-2xl border px-5 py-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Audience signal</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="tabular text-[24px] font-semibold leading-none" style={{ color: "var(--warning)" }}>{formatNumber(comments.needsResponse)}</span>
            <span className="text-[12px] text-muted">need a response</span>
          </div>
          <div className="mt-auto pt-2 text-[12px] text-muted-strong">
            {formatNumber(comments.total)} comments · {formatNumber(comments.recruiting)} recruiting · {formatNumber(comments.wachter)} Wachter
            {responseVideo ? ` · top: ${responseVideo.title.slice(0, 28)}` : ""}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlatformsSlide({ data, f }: { data: ReportsData; f: ReportFilters }) {
  const vids = filterVideos(data.videos, f);
  const rolls = rollupByPlatform(vids);
  if (rolls.length === 0) return <EmptySlideNote>No platform data for this filter combination.</EmptySlideNote>;
  const totalViews = sumReal(rolls.map((r) => r.totalViews)) ?? 0;
  const sorted = [...rolls].sort((a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1));
  const freshness = new Map(data.platforms.map((p) => [p.platform, p]));

  return (
    <div className="grid h-full grid-cols-2 gap-4" style={{ gridAutoRows: "1fr" }}>
      {sorted.map((r) => {
        const fr = freshness.get(r.platform);
        const topVideo = rankVideos(vids.filter((v) => v.platform === r.platform), "views")[0] ?? null;
        const share = totalViews > 0 ? (r.totalViews ?? 0) / totalViews : null;
        return (
          <div key={r.platform} className="flex flex-col rounded-2xl border px-6 py-5" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[16px] font-semibold">
                <span className="h-3 w-3 rounded-full" style={{ background: PLATFORM_HEX[r.platform] }} />
                {PLATFORM_LABELS[r.platform]}
              </span>
              <span className="tabular text-[13px] text-muted">
                <span className="font-semibold text-foreground">{formatPct(share)}</span> of views
              </span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3">
              <Stat label="Views" value={formatCompact(r.totalViews)} />
              <Stat label={`Growth · ${data.meta.range}`} value={r.totalGrowth === null ? "—" : `+${formatCompact(r.totalGrowth)}`} />
              <Stat label="Engagements" value={formatCompact(r.totalEngagements)} />
              <Stat label="Comments" value={formatCompact(r.totalComments)} />
              <Stat label="Eng. rate" value={formatPct(r.engagementRate)} />
              <Stat label="Videos" value={formatNumber(r.count)} />
            </div>
            <div className="mt-4 border-t pt-3" style={{ borderColor: "var(--border)" }}>
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted">Top video</div>
              {topVideo ? (
                <div className="mt-1 flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{topVideo.title}</span>
                  <span className="tabular shrink-0 text-[13px] font-semibold">{fmtMetric(topVideo.views, "views")}</span>
                </div>
              ) : (
                <div className="mt-1 text-[13px] text-muted">No confirmed views yet</div>
              )}
            </div>
            <div className="mt-auto pt-3 text-[11px] text-muted-strong">
              {fr
                ? `${fr.freshness === "high" ? "Live" : fr.freshness === "failed" ? "Last refresh failed" : "Last-known-good"}${
                    fr.lastSuccessfulRefreshAt ? ` · ${formatDate(fr.lastSuccessfulRefreshAt)}` : ""
                  }`
                : ""}
            </div>
          </div>
        );
      })}
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

/** Best platform (by views) among a concept's videos. */
function bestPlatformForConcept(videos: ReportVideo[], conceptId: string): Platform | null {
  const members = videos.filter((v) => (conceptId === "__unassigned" ? !v.episodeId : v.episodeId === conceptId));
  const byPlatform = new Map<Platform, number>();
  for (const v of members) if (v.views !== null) byPlatform.set(v.platform, (byPlatform.get(v.platform) ?? 0) + v.views);
  return [...byPlatform.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
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

  // Winning concept = highest by the focus metric; its best video by views.
  const winner = sorted[0];
  const winnerVideos = vids.filter((v) =>
    winner.id === "__unassigned" ? !v.episodeId : v.episodeId === winner.id,
  );
  const winnerBestVideo = rankVideos(winnerVideos, "views")[0] ?? null;
  const winnerBestPlatform = bestPlatformForConcept(vids, winner.id);

  return (
    <div className="grid h-full grid-cols-[1.5fr_1fr] gap-5">
      {/* Leaderboard */}
      <div className="flex min-h-0 flex-col rounded-2xl border px-7 py-6" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-semibold uppercase tracking-wide text-muted">Concepts · ranked by {metricLabel(f.metric).toLowerCase()}</div>
          <div className="text-[12px] text-muted">{formatNumber(sorted.length)} concepts</div>
        </div>
        <div className="mt-5 flex min-h-0 flex-1 flex-col justify-between gap-3">
          {sorted.slice(0, 6).map((r, i) => {
            const perVideo = r.totalViews !== null && r.count > 0 ? r.totalViews / r.count : null;
            const bp = bestPlatformForConcept(vids, r.id);
            return (
              <div key={r.id} className="flex items-center gap-4">
                <span className="tabular w-5 shrink-0 text-[15px] font-semibold text-muted-strong">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <BarRow
                    label={<span className="truncate">{r.name}</span>}
                    valueText={fmtMetric(metricOf(r), f.metric)}
                    fraction={(metricOf(r) ?? 0) / maxV}
                    color={palette[i % palette.length]}
                    metaText={`${formatNumber(r.count)} videos · ${fmtMetric(perVideo, "views")}/video · ${formatPct(r.engagementRate)} ER${bp ? ` · best on ${PLATFORM_LABELS[bp]}` : ""}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Winning concept spotlight */}
      <div className="flex min-h-0 flex-col rounded-2xl border px-6 py-6" style={{ borderColor: "var(--accent)", background: "var(--accent-soft)" }}>
        <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">Winning concept</div>
        <div className="mt-2 text-[26px] font-semibold leading-tight tracking-tight">{winner.name}</div>
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Total views" value={formatCompact(winner.totalViews)} />
          <Stat label="Eng. rate" value={formatPct(winner.engagementRate)} />
          <Stat label="Videos" value={formatNumber(winner.count)} />
          <Stat label="Best platform" value={winnerBestPlatform ? PLATFORM_LABELS[winnerBestPlatform].split(" ")[0] : "—"} />
        </div>
        <div className="mt-auto border-t pt-3" style={{ borderColor: "var(--border-strong)" }}>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted">Best video</div>
          {winnerBestVideo ? (
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{winnerBestVideo.title}</span>
              <span className="tabular shrink-0 text-[13px] font-semibold">{fmtMetric(winnerBestVideo.views, "views")}</span>
            </div>
          ) : (
            <div className="mt-1 text-[13px] text-muted">No confirmed views yet</div>
          )}
        </div>
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
  const scope = f.platform === "all" ? "" : ` · ${PLATFORM_LABELS[f.platform]}`;
  const conceptLabel =
    f.conceptId === "all" ? "All concepts" : data.concepts.find((c) => c.id === f.conceptId)?.name ?? "Concept";
  const conceptName = f.conceptId === "all" ? "" : ` · ${conceptLabel}`;
  // Footer "selected filters summary".
  const filtersSummary = [
    `Range ${data.meta.rangeLabel}`,
    `Platform ${f.platform === "all" ? "All" : PLATFORM_LABELS[f.platform]}`,
    `Concept ${conceptLabel}`,
    `Focus ${metricLabel(f.metric)}`,
  ].join(" · ");
  return (
    <SlideFrame data={data} title={title} subtitle={`${SLIDE_SUBTITLE[f.type]}${scope}${conceptName}`} filtersSummary={filtersSummary}>
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
  // Modal open/close (transitions.dev #06) for the presentation overlay: the
  // surface scales up from --modal-scale on open and dips back on close.
  const [presentMode, setPresentMode] = useState<"pre" | "open" | "closing">("pre");
  const presentCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const PRESENT_CLOSE_MS = 150; // matches --modal-close-dur
  const openPresent = () => {
    if (presentCloseTimer.current) clearTimeout(presentCloseTimer.current);
    setPresenting(true);
    requestAnimationFrame(() => setPresentMode("open"));
  };
  const closePresent = () => {
    setPresentMode("closing");
    presentCloseTimer.current = setTimeout(() => {
      setPresenting(false);
      setPresentMode("pre");
    }, PRESENT_CLOSE_MS);
  };

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
      if (e.key === "Escape") closePresent();
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
              onClick={openPresent}
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
            onClick={closePresent}
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
          <div
            className={`t-modal${presentMode === "open" ? " is-open" : presentMode === "closing" ? " is-closing" : ""}`}
            style={{ width: CANVAS_W * presScale, height: CANVAS_H * presScale }}
          >
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
