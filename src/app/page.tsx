// Main campaign dashboard — the 30-second executive read on the
// Cybernick0x × Wachter creator campaign.

import clsx from "clsx";
import Link from "next/link";
import {
  Activity,
  Eye,
  Film,
  Heart,
  MessagesSquare,
  TrendingUp,
} from "lucide-react";
import { getDashboardData, type TimeRange } from "@/lib/queries";
import { PLATFORM_LABELS } from "@/lib/types";
import { formatCompact, formatDate, formatDelta, formatNumber, formatPct, timeAgo, truncate } from "@/lib/format";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { SourceStatusPanel } from "@/components/dashboard/source-status";
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

export const dynamic = "force-dynamic";

const RANGE_LABELS: Record<TimeRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  all: "All time",
};

function parseRange(value: string | string[] | undefined): TimeRange {
  return value === "24h" || value === "7d" || value === "30d" || value === "all" ? value : "7d";
}

/** Which platform drove the largest share of view growth this period. */
function growthLeader(
  trendByPlatform: import("@/lib/queries").DashboardData["trendByPlatform"],
): { platform: import("@/lib/types").Platform; pct: number } | null {
  const deltas: Array<{ platform: import("@/lib/types").Platform; gained: number }> = [];
  for (const [platform, series] of Object.entries(trendByPlatform)) {
    const withViews = (series ?? []).filter((pt) => pt.views !== null);
    const first = withViews[0];
    const last = withViews[withViews.length - 1];
    if (first && last && first !== last) {
      const gained = (last.views as number) - (first.views as number);
      if (gained > 0) deltas.push({ platform: platform as import("@/lib/types").Platform, gained });
    }
  }
  const total = deltas.reduce((a, b) => a + b.gained, 0);
  if (total <= 0) return null;
  const top = deltas.sort((a, b) => b.gained - a.gained)[0];
  return { platform: top.platform, pct: Math.round((top.gained / total) * 100) };
}

/**
 * Honest connection status: counts connected sources and flags metric gaps —
 * never claims "all systems live" while known fields are unavailable.
 */
function SystemsIndicator({
  liveCount,
  total,
  anyFailed,
  hasGaps,
  delayed,
}: {
  liveCount: number;
  total: number;
  anyFailed: boolean;
  hasGaps: boolean;
  delayed: boolean;
}) {
  const tone = anyFailed
    ? { dot: "bg-negative", text: "text-negative", label: `Refresh issues · ${liveCount}/${total} connected` }
    : liveCount === total && total > 0
      ? { dot: "bg-positive", text: "text-positive", label: `${total} data sources connected` }
      : { dot: "bg-warning", text: "text-warning", label: `${liveCount}/${total} data sources connected` };
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      <span
        className={clsx(
          "inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium whitespace-nowrap",
          tone.text,
        )}
        role="status"
      >
        <span className={clsx("h-2 w-2 rounded-full", tone.dot, !anyFailed && liveCount > 0 && "animate-pulse")} />
        {tone.label}
      </span>
      {hasGaps && !anyFailed && (
        <span
          className="inline-flex items-center rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[11px] text-muted whitespace-nowrap"
          title="Some platforms don't expose every metric — see Data sources below for details"
        >
          Some metrics unavailable
        </span>
      )}
      {delayed && !anyFailed && (
        <span
          className="inline-flex items-center rounded-lg border border-warning/30 bg-[rgba(251,191,36,0.05)] px-2.5 py-1.5 text-[11px] text-warning/90 whitespace-nowrap"
          title="A platform's source appears to be returning delayed metrics — see Data sources for detail"
        >
          Some platform data may be delayed
        </span>
      )}
    </span>
  );
}

function ConfidenceBadge({
  confidence,
}: {
  confidence: import("@/lib/executive").DataConfidence;
}) {
  const tone =
    confidence.level === "high"
      ? { dot: "bg-positive", text: "text-positive" }
      : confidence.level === "partial"
        ? { dot: "bg-warning", text: "text-warning" }
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

function PeriodStat({
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
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-strong">{label}</div>
      <div
        className={clsx(
          "tabular mt-0.5 truncate text-sm font-semibold",
          positive ? "text-positive" : "text-foreground",
        )}
        title={value}
      >
        {value}
      </div>
      {sub && <div className="tabular text-[10px] text-muted">{sub}</div>}
    </div>
  );
}

function HeroStat({
  label,
  value,
  emphasis,
  positive,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  positive?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-strong">
        {label}
      </span>
      <span
        className={clsx(
          "tabular-nums font-bold leading-tight tracking-tight",
          emphasis ? "text-xl" : "text-base",
          positive ? "text-positive" : "text-foreground",
        )}
      >
        {value}
      </span>
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

  const fastestTitle = kpis.fastestGrowing
    ? (kpis.fastestGrowing.video.title ?? kpis.fastestGrowing.video.caption ?? "Untitled video")
    : null;

  // Narrative layer for the momentum card — real computed insights only.
  const leader = growthLeader(data.trendByPlatform);
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

  return (
    <div>
      <DataNotice health={health} />

      {/* Executive hero — the 10-second story */}
      <div className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent">
              Campaign performance
            </div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight lg:text-[28px]">
              Cybernick0x × Wachter
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <span>Cross-platform campaign tracker · shared live view for all viewers</span>
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
            <SystemsIndicator
              liveCount={liveCount}
              total={health.platforms.length}
              anyFailed={anyFailed}
              hasGaps={hasGaps}
              delayed={anyDelayed}
            />
            <AutoRefreshNote />
          </div>
        </div>

        {/* At-a-glance strip: the five numbers an executive asks for first. */}
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border bg-surface/60 px-4 py-3">
          <HeroStat
            label="Total views"
            value={kpis.totalViews !== null ? formatCompact(kpis.totalViews) : "—"}
            emphasis
          />
          <HeroStat
            label="Views 24h"
            value={kpis.viewsGained24h !== null ? formatDelta(kpis.viewsGained24h) : "—"}
            positive={(kpis.viewsGained24h ?? 0) > 0}
          />
          <HeroStat
            label="Engagements"
            value={kpis.totalEngagements !== null ? formatCompact(kpis.totalEngagements) : "—"}
          />
          <HeroStat label="Videos tracked" value={formatNumber(kpis.videosTracked)} />
          <HeroStat
            label="Platforms"
            value={`${liveCount}/${health.platforms.length} live`}
          />
          <HeroStat
            label="Response opportunities"
            value={formatNumber(commentStats.needsResponse)}
          />
        </div>

        {data.insights.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {data.insights.map((line) => (
              <span
                key={line}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[11px] text-foreground/85"
              >
                <span aria-hidden className="h-1 w-1 rounded-full bg-accent" />
                {line}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Per-platform source status with expandable capability details.
          SourceStatusPanel is a client component — its props serialize into
          the public page payload, so only this sanitized projection (no actor
          IDs, no provider/vendor names, no setup language) may cross. */}
      <SourceStatusPanel
        platforms={health.platforms.map((p) => ({
          platform: p.platform,
          sourceStatus: p.sourceStatus,
          statusDetail:
            p.sourceStatus === "live" || p.sourceStatus === "waiting"
              ? null
              : "Not connected — configure in Admin",
          lastSuccessfulRefreshAt: p.lastSuccessfulRefreshAt,
          supportsComments: p.supportsComments,
          supportsDiscovery: p.supportsDiscovery,
          sourceLabel:
            p.providerType === "youtube_api"
              ? "Official YouTube API"
              : p.providerType === "mock"
                ? "Demo data"
                : p.providerType === "manual"
                  ? "Manual entry"
                  : "Automated collection",
        }))}
        capabilities={data.sourceCapabilities.map((c) =>
          c.live ? c : { ...c, summary: "Not connected — configure in Admin" },
        )}
      />

      <div className="space-y-6">
        {/* KPI grid — six intentional numbers, each with context */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
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
            accent={
              kpis.viewsGained24h !== null && kpis.viewsGained24h > 0 ? "#34d399" : undefined
            }
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
            label="Engagement rate"
            icon={<Activity />}
            value={kpis.avgEngagementRate !== null ? formatPct(kpis.avgEngagementRate) : null}
            context="Average across tracked videos"
            unavailableReason="No engagement data yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Videos tracked"
            icon={<Film />}
            value={formatNumber(kpis.videosTracked)}
            context={`Across ${health.platforms.length} platforms`}
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Response opportunities"
            icon={<MessagesSquare />}
            value={formatNumber(commentStats.needsResponse)}
            context="Comments awaiting a reply"
            updatedAt={updatedAt}
          />
        </div>

        {/* Campaign momentum — the centerpiece chart with its story */}
        <Card>
          <CardHeader
            title="Campaign momentum"
            subtitle={momentumNarrative}
            action={<RangeSwitcher active={range} />}
          />
          <CardBody>
            {trendHasData && (
              <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <PeriodStat
                  label={`Views gained · ${RANGE_LABELS[range].toLowerCase()}`}
                  value={data.periodDelta.views !== null ? formatDelta(data.periodDelta.views) : "—"}
                  positive={(data.periodDelta.views ?? 0) > 0}
                />
                <PeriodStat
                  label="Engagements gained"
                  value={
                    data.periodDelta.engagements !== null
                      ? formatDelta(data.periodDelta.engagements)
                      : "—"
                  }
                  positive={(data.periodDelta.engagements ?? 0) > 0}
                />
                <PeriodStat
                  label="Growth leader"
                  value={
                    leader
                      ? `${PLATFORM_LABELS[leader.platform]}`
                      : momentum.bestPlatformToday
                        ? PLATFORM_LABELS[momentum.bestPlatformToday.platform]
                        : "—"
                  }
                  sub={
                    leader
                      ? `${leader.pct}% of view growth this period`
                      : momentum.bestPlatformToday
                        ? `${formatDelta(momentum.bestPlatformToday.gained)} views today`
                        : undefined
                  }
                />
                <PeriodStat
                  label="Fastest-growing video"
                  value={fastestTitle ? truncate(fastestTitle, 26) : "—"}
                  sub={
                    kpis.fastestGrowing
                      ? `${formatDelta(kpis.fastestGrowing.gained24h)} views 24h`
                      : undefined
                  }
                />
              </div>
            )}
            {!trendHasData ? (
              <EmptyState
                title="Waiting for first refresh"
                detail="The trend line draws itself as snapshots accumulate. Connect a provider and run a refresh to start capturing data."
              />
            ) : data.trendIsSparse ? (
              <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border bg-surface px-6 py-10 text-center">
                <div className="text-sm font-medium text-muted">Tracking history is building</div>
                <div className="max-w-md text-xs text-muted-strong">
                  Metrics are captured on every refresh — the totals above are live now, and the
                  trend line fills in as history accumulates.
                </div>
              </div>
            ) : (
              <MomentumChart data={data.trend} byPlatform={data.trendByPlatform} />
            )}
          </CardBody>
        </Card>

        {/* Platform comparison — ranked by views so the winner reads instantly */}
        <section aria-label="Platform comparison">
          <SectionTitle className="mb-3">Platform comparison</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(() => {
              const totalViews = data.platformStats.reduce((a, s) => a + (s.views ?? 0), 0);
              return [...data.platformStats]
                .sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
                .map((s, i) => (
                  <PlatformCard
                    key={s.platform}
                    stats={s}
                    rank={i + 1}
                    shareOfViews={
                      totalViews > 0 && s.views !== null
                        ? Math.round((s.views / totalViews) * 100)
                        : null
                    }
                  />
                ));
            })()}
          </div>
        </section>

        {/* Top videos */}
        <Card>
          <CardHeader
            title="Top videos"
            subtitle="Leaderboards across all platforms"
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

        {/* Momentum + comment intelligence */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <MomentumCard momentum={momentum} />
          <CommentIntelCard
            commentStats={commentStats}
            recentComments={data.recentComments}
            responseOpportunities={data.responseOpportunities}
          />
        </div>

        {/* Alerts preview */}
        <section aria-label="Open alerts">
          <AlertsPreview alerts={data.openAlerts} />
        </section>
      </div>
    </div>
  );
}
