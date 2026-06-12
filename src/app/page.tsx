// Main campaign dashboard — the 30-second executive read on the
// Cybernick0x × Wachter creator campaign.
//
// Hierarchy (Phase 3.5): performance first, diagnostics last. Hero →
// four-number KPI strip → the Campaign Momentum centerpiece → the content
// that explains it (Top Videos, Platform comparison) → audience signals →
// a collapsible Data status drawer with the full operational detail.

import clsx from "clsx";
import Link from "next/link";
import { Eye, Heart, TrendingUp, Trophy } from "lucide-react";
import { getDashboardData, type TimeRange } from "@/lib/queries";
import { PLATFORM_LABELS, type Platform } from "@/lib/types";
import type { TrendPoint } from "@/lib/metrics";
import {
  formatCompact,
  formatDate,
  formatDelta,
  formatNumber,
  formatPct,
  timeAgo,
  truncate,
} from "@/lib/format";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { TimeAgo } from "@/components/ui/time-ago";
import { EmptyState } from "@/components/ui/empty-state";
import { AutoRefreshNote } from "@/components/ui/auto-refresh-note";
import { DataNotice } from "@/components/layout/data-notice";
import { MomentumChart } from "@/components/charts/momentum-chart";
import { RangeSwitcher } from "@/components/dashboard/range-switcher";
import { Leaderboard } from "@/components/dashboard/leaderboard";
import { PlatformCard } from "@/components/dashboard/platform-card";
import { MomentumCard } from "@/components/dashboard/momentum-card";
import { CommentIntelCard } from "@/components/dashboard/comment-intel-card";
import { AlertsPreview } from "@/components/dashboard/alerts-preview";
import { DataStatusDrawer } from "@/components/dashboard/data-status";
import { coverageNote, historyBeganNote } from "@/lib/range";

export const dynamic = "force-dynamic";

const RANGE_LABELS: Record<TimeRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

const PLATFORM_HEX: Record<Platform, string> = {
  tiktok: "#25f4ee",
  youtube: "#ff4444",
  instagram: "#e95daa",
  facebook: "#4b8dff",
};

function parseRange(value: string | string[] | undefined): TimeRange {
  return value === "24h" || value === "7d" || value === "30d" || value === "all" ? value : "7d";
}

/** Per-platform share of view growth across the selected range. */
function growthShares(
  trendByPlatform: Partial<Record<Platform, TrendPoint[]>>,
): Array<{ platform: Platform; gained: number; pct: number }> {
  const deltas: Array<{ platform: Platform; gained: number }> = [];
  for (const [platform, series] of Object.entries(trendByPlatform) as Array<
    [Platform, TrendPoint[]]
  >) {
    const withViews = (series ?? []).filter((pt) => pt.views !== null);
    const first = withViews[0];
    const last = withViews[withViews.length - 1];
    if (first && last && first !== last) {
      const gained = (last.views as number) - (first.views as number);
      if (gained > 0) deltas.push({ platform, gained });
    }
  }
  const total = deltas.reduce((a, b) => a + b.gained, 0);
  if (total <= 0) return [];
  return deltas
    .sort((a, b) => b.gained - a.gained)
    .map((d) => ({ ...d, pct: Math.round((d.gained / total) * 100) }));
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: import("@/lib/executive").DataConfidence;
}) {
  // "partial" now means core metrics ARE verified (some counts from a prior
  // refresh) — styled calm, not as a warning. Only "building" gets accent.
  const tone =
    confidence.level === "high" || confidence.level === "partial"
      ? { dot: "bg-positive", text: "text-foreground/85" }
      : { dot: "bg-accent", text: "text-accent" };
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium whitespace-nowrap",
        tone.text,
      )}
      title={`${confidence.detail}${confidence.verifiedAt ? ` Last verified ${timeAgo(confidence.verifiedAt)}.` : ""}`}
      role="status"
    >
      <span className={clsx("h-2 w-2 rounded-full", tone.dot)} />
      {confidence.headline}
    </span>
  );
}

/** One stat in the momentum card's insight rail. */
function RailStat({
  label,
  value,
  sub,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-strong">
        {label}
      </div>
      <div
        className={clsx(
          "tabular-nums mt-1 truncate text-lg font-bold leading-tight tracking-tight",
          positive ? "text-positive" : "text-foreground",
        )}
        title={value}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const data = await getDashboardData(range);
  const { health, kpis, momentum, commentStats } = data;

  const liveCount = health.platforms.filter((p) => p.sourceStatus === "live").length;
  const anyFailed = health.platforms.some((p) => p.sourceStatus === "refresh_failed");
  const hasGaps = data.sourceCapabilities.some((c) => c.live && c.gaps.length > 0);
  const anyDelayed = data.sourceCapabilities.some(
    (c) => c.live && (c.freshness === "stale" || c.freshnessNote !== null),
  );
  const lastRun = health.lastRun;
  // While a refresh is mid-flight, data is at least as fresh as its start —
  // better than flashing "Awaiting first refresh" over real numbers.
  const updatedAt = lastRun?.finishedAt ?? lastRun?.startedAt ?? null;
  const trendHasData = data.trend.some((p) => p.views !== null);

  // Narrative layer for the momentum card — real computed insights only.
  const shares = growthShares(data.trendByPlatform);
  const leader = shares[0] ?? null;
  const momentumNarrative = !trendHasData
    ? "Tracked totals will plot here after the first refresh"
    : data.trendIsSparse
      ? "Campaign tracking history is building — totals are live, the line fills in over time"
      : [
          data.periodDelta.views !== null && data.periodDelta.views > 0
            ? `${formatDelta(data.periodDelta.views)} views ${RANGE_LABELS[range].toLowerCase()}`
            : null,
          leader ? `${PLATFORM_LABELS[leader.platform]} drove ${leader.pct}% of growth` : null,
        ]
          .filter(Boolean)
          .join(" · ") || `Tracked totals over real snapshots · ${RANGE_LABELS[range]}`;

  // Honest history coverage for the selected range.
  const coverage = coverageNote(range, data.historyStart);

  // Best platform for the KPI strip — by total confirmed views.
  const totalPlatformViews = data.platformStats.reduce((a, s) => a + (s.views ?? 0), 0);
  const bestPlatform = [...data.platformStats]
    .filter((s) => s.views !== null)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];

  return (
    <div>
      <DataNotice health={health} />

      {/* Hero — title left, one compact status cluster right. Operational
          chips live in the Data status drawer at the bottom of the page. */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
            Campaign performance
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight lg:text-[28px]">
            Cybernick0x × Wachter
          </h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>Cross-platform creator campaign</span>
            <span aria-hidden className="text-muted-strong">·</span>
            <span>
              {data.dateRange.from
                ? `Since ${formatDate(data.dateRange.from)}`
                : "Start date pending first refresh"}
            </span>
            <span aria-hidden className="text-muted-strong">·</span>
            <span>
              Last refreshed{" "}
              <TimeAgo iso={lastRun ? (lastRun.finishedAt ?? lastRun.startedAt) : null} />
              {lastRun && lastRun.status !== "success" && (
                <span
                  className={clsx(
                    "ml-1 font-medium",
                    lastRun.status === "failed" && "text-negative",
                    lastRun.status === "partial" && "text-warning",
                    lastRun.status === "running" && "text-accent",
                  )}
                >
                  ({lastRun.status})
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <ConfidenceBadge confidence={data.confidence} />
          <AutoRefreshNote />
        </div>
      </div>

      <div className="space-y-6">
        {/* Primary KPI strip — the four numbers leadership asks for first */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard
            label="Total views"
            icon={<Eye />}
            value={kpis.totalViews !== null ? formatCompact(kpis.totalViews) : null}
            context="All platforms, confirmed plays"
            unavailableReason="No connected source yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="24h growth"
            icon={<TrendingUp />}
            value={kpis.viewsGained24h !== null ? formatDelta(kpis.viewsGained24h) : null}
            context="New views in the last day"
            unavailableReason="Needs two snapshots"
            updatedAt={updatedAt}
            accent={kpis.viewsGained24h !== null && kpis.viewsGained24h > 0 ? "#34d399" : undefined}
          />
          <KpiCard
            label="Engagements"
            icon={<Heart />}
            value={kpis.totalEngagements !== null ? formatCompact(kpis.totalEngagements) : null}
            delta={data.periodDelta.engagements}
            deltaLabel="this period"
            context="Likes + comments + shares"
            unavailableReason="No connected source yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Top platform"
            icon={<Trophy />}
            value={bestPlatform ? PLATFORM_LABELS[bestPlatform.platform] : null}
            context={
              bestPlatform && totalPlatformViews > 0
                ? `${Math.round(((bestPlatform.views ?? 0) / totalPlatformViews) * 100)}% of campaign views (${formatCompact(bestPlatform.views)})`
                : undefined
            }
            unavailableReason="No confirmed views yet"
            updatedAt={updatedAt}
          />
        </div>

        {/* Campaign momentum — the centerpiece */}
        <Card>
          <CardHeader
            title={
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                Campaign momentum
                {kpis.totalViews !== null && (
                  <span className="tabular-nums text-xl font-bold tracking-tight text-foreground">
                    {formatCompact(kpis.totalViews)}
                    <span className="ml-1.5 text-xs font-normal text-muted">views total</span>
                  </span>
                )}
              </span>
            }
            subtitle={
              coverage ? (
                <>
                  {momentumNarrative}
                  <span className="mt-0.5 block text-[11px] text-muted-strong">{coverage}</span>
                </>
              ) : (
                momentumNarrative
              )
            }
            action={<RangeSwitcher active={range} />}
          />
          <CardBody>
            {!trendHasData ? (
              <EmptyState
                title="Waiting for first refresh"
                detail="The trend line draws itself as snapshots accumulate. Connect a provider and run a refresh to start capturing data."
              />
            ) : data.trendIsSparse ? (
              <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border bg-surface px-6 py-10 text-center">
                <div className="text-sm font-medium text-muted">Tracking history is building</div>
                <div className="max-w-md text-xs text-muted-strong">
                  {historyBeganNote(data.historyStart)} The totals above are live now.
                </div>
              </div>
            ) : (
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
                <MomentumChart
                  data={data.trend}
                  byPlatform={data.trendByPlatform}
                  height={360}
                  range={range}
                />

                {/* Insight rail — the story beside the line */}
                <div className="flex flex-col gap-2.5">
                  <RailStat
                    label={`Views gained · ${RANGE_LABELS[range].toLowerCase()}`}
                    value={
                      data.periodDelta.views !== null ? formatDelta(data.periodDelta.views) : "—"
                    }
                    positive={(data.periodDelta.views ?? 0) > 0}
                  />
                  <RailStat
                    label="Engagements gained"
                    value={
                      data.periodDelta.engagements !== null
                        ? formatDelta(data.periodDelta.engagements)
                        : "—"
                    }
                    positive={(data.periodDelta.engagements ?? 0) > 0}
                  />
                  <RailStat
                    label={`Fastest-growing video · ${RANGE_LABELS[range].toLowerCase()}`}
                    value={
                      data.periodFastestGrowing
                        ? truncate(
                            data.periodFastestGrowing.video.title ??
                              data.periodFastestGrowing.video.caption ??
                              "Untitled video",
                            30,
                          )
                        : "—"
                    }
                    sub={
                      data.periodFastestGrowing
                        ? `${formatDelta(data.periodFastestGrowing.gained)} views this period`
                        : "Needs two confirmed readings in range"
                    }
                  />

                  {/* Platform contribution to growth this period */}
                  {shares.length > 0 && (
                    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
                      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-strong">
                        Growth by platform
                      </div>
                      <div className="mt-2 space-y-2">
                        {shares.map((s) => (
                          <div key={s.platform}>
                            <div className="flex items-baseline justify-between text-[11px]">
                              <span className="text-muted">{PLATFORM_LABELS[s.platform]}</span>
                              <span className="tabular-nums font-medium">
                                {formatDelta(s.gained)}
                                <span className="ml-1 text-muted-strong">{s.pct}%</span>
                              </span>
                            </div>
                            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-hover">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.max(2, s.pct)}%`,
                                  background: PLATFORM_HEX[s.platform],
                                  opacity: 0.85,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {data.insights.length > 0 && (
                    <div className="mt-auto space-y-1.5 pt-1">
                      {data.insights.slice(0, 2).map((line) => (
                        <div
                          key={line}
                          className="flex items-start gap-1.5 text-[11px] leading-snug text-muted"
                        >
                          <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
                          {line}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardBody>
        </Card>

        {/* Top videos — what's causing the line to move */}
        <Card>
          <CardHeader
            title="Top videos"
            subtitle="The content behind the momentum"
            action={
              <Link
                href="/videos"
                className="shrink-0 text-xs font-medium text-accent transition-colors hover:underline"
              >
                All videos →
              </Link>
            }
          />
          <CardBody>
            <Leaderboard leaderboard={data.leaderboard} />
          </CardBody>
        </Card>

        {/* Platform comparison — ranked by views so the winner reads instantly */}
        <section aria-label="Platform comparison">
          <SectionTitle className="mb-3">Platform comparison</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[...data.platformStats]
              .sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
              .map((s, i) => (
                <PlatformCard
                  key={s.platform}
                  stats={s}
                  rank={i + 1}
                  shareOfViews={
                    totalPlatformViews > 0 && s.views !== null
                      ? Math.round((s.views / totalPlatformViews) * 100)
                      : null
                  }
                />
              ))}
          </div>
        </section>

        {/* Supporting metrics — useful, but not top-of-page material */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard
            label="Engagement rate"
            value={kpis.avgEngagementRate !== null ? formatPct(kpis.avgEngagementRate) : null}
            context="Average across tracked videos"
            unavailableReason="No engagement data yet"
          />
          <KpiCard
            label="Total comments"
            value={kpis.totalComments !== null ? formatCompact(kpis.totalComments) : null}
            context="Captured across platforms"
            unavailableReason="No connected source yet"
          />
          <KpiCard
            label="Videos tracked"
            value={formatNumber(kpis.videosTracked)}
            context={`Across ${health.platforms.length} platforms`}
          />
          <KpiCard
            label="Response opportunities"
            value={formatNumber(commentStats.needsResponse)}
            context="Comments awaiting a reply"
          />
        </div>

        {/* Momentum velocity + audience signals */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <MomentumCard momentum={momentum} />
          <CommentIntelCard
            commentStats={commentStats}
            recentComments={data.recentComments}
            responseOpportunities={data.responseOpportunities}
          />
        </div>

        {/* Operational truth — honest, complete, and one click away */}
        <DataStatusDrawer
          health={health}
          capabilities={data.sourceCapabilities}
          liveCount={liveCount}
          anyFailed={anyFailed}
          hasGaps={hasGaps}
          delayed={anyDelayed}
        />

        {/* Alerts preview */}
        <section aria-label="Open alerts">
          <AlertsPreview alerts={data.openAlerts} />
        </section>
      </div>
    </div>
  );
}
