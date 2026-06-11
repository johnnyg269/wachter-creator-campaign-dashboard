// Main campaign dashboard — the 30-second executive read on the
// Cybernick0x × Wachter creator campaign.

import clsx from "clsx";
import Link from "next/link";
import { getDashboardData, type TimeRange } from "@/lib/queries";
import { PLATFORM_LABELS } from "@/lib/types";
import { formatCompact, formatDate, formatDelta, formatNumber, formatPct, truncate } from "@/lib/format";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { SourceStatusPanel } from "@/components/dashboard/source-status";
import { TimeAgo } from "@/components/ui/time-ago";
import { EmptyState } from "@/components/ui/empty-state";
import { RefreshButton } from "@/components/ui/refresh-button";
import { PageHeader } from "@/components/layout/page-header";
import { DataNotice } from "@/components/layout/data-notice";
import { TrendChart } from "@/components/charts/trend-chart";
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

/**
 * Honest connection status: counts connected sources and flags metric gaps —
 * never claims "all systems live" while known fields are unavailable.
 */
function SystemsIndicator({
  liveCount,
  total,
  anyFailed,
  hasGaps,
}: {
  liveCount: number;
  total: number;
  anyFailed: boolean;
  hasGaps: boolean;
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
  const lastRun = health.lastRun;
  // While a refresh is mid-flight, data is at least as fresh as its start —
  // better than flashing "Awaiting first refresh" over real numbers.
  const updatedAt = lastRun?.finishedAt ?? lastRun?.startedAt ?? null;
  const trendHasData = data.trend.some((p) => p.views !== null);

  const fastestTitle = kpis.fastestGrowing
    ? (kpis.fastestGrowing.video.title ?? kpis.fastestGrowing.video.caption ?? "Untitled video")
    : null;

  return (
    <div>
      <DataNotice health={health} />

      <PageHeader
        title="Cybernick0x × Wachter Campaign"
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {data.dateRange.from
                ? `Campaign since ${formatDate(data.dateRange.from)}`
                : "Start date pending first refresh"}
            </span>
            <span aria-hidden className="text-muted-strong">
              ·
            </span>
            <span>
              {lastRun ? (
                <>
                  Last refresh{" "}
                  <span
                    className={clsx(
                      "font-medium",
                      lastRun.status === "success" && "text-positive",
                      lastRun.status === "failed" && "text-negative",
                      lastRun.status === "partial" && "text-warning",
                      lastRun.status === "running" && "text-accent",
                    )}
                  >
                    {lastRun.status}
                  </span>{" "}
                  <TimeAgo iso={lastRun.finishedAt ?? lastRun.startedAt} />
                </>
              ) : (
                "No refresh runs yet"
              )}
            </span>
          </span>
        }
        actions={
          <>
            <SystemsIndicator
              liveCount={liveCount}
              total={health.platforms.length}
              anyFailed={anyFailed}
              hasGaps={hasGaps}
            />
            <RefreshButton />
          </>
        }
      />

      {/* Per-platform source status with expandable capability details */}
      <SourceStatusPanel platforms={health.platforms} capabilities={data.sourceCapabilities} />

      <div className="space-y-6">
        {/* KPI grid */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard
            label="Total views"
            value={kpis.totalViews !== null ? formatCompact(kpis.totalViews) : null}
            delta={kpis.viewsGained24h}
            deltaLabel="24h"
            unavailableReason="No connected source yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Total engagements"
            value={kpis.totalEngagements !== null ? formatCompact(kpis.totalEngagements) : null}
            delta={data.periodDelta.engagements}
            deltaLabel="this period"
            unavailableReason="No connected source yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Total likes"
            value={kpis.totalLikes !== null ? formatCompact(kpis.totalLikes) : null}
            unavailableReason="No connected source yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Total comments"
            value={kpis.totalComments !== null ? formatCompact(kpis.totalComments) : null}
            unavailableReason="No connected source yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Avg engagement rate"
            value={kpis.avgEngagementRate !== null ? formatPct(kpis.avgEngagementRate) : null}
            unavailableReason="No engagement data yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Videos tracked"
            value={formatNumber(kpis.videosTracked)}
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Views gained 24h"
            value={kpis.viewsGained24h !== null ? formatDelta(kpis.viewsGained24h) : null}
            unavailableReason="Needs two snapshots"
            updatedAt={updatedAt}
            accent={
              kpis.viewsGained24h !== null && kpis.viewsGained24h !== 0
                ? kpis.viewsGained24h > 0
                  ? "#34d399"
                  : "#f87171"
                : undefined
            }
          />
          {kpis.fastestGrowing && fastestTitle ? (
            <KpiCard
              label="Fastest-growing video"
              value={truncate(fastestTitle, 20)}
              delta={kpis.fastestGrowing.gained24h}
              deltaLabel="views 24h"
              updatedAt={updatedAt}
            />
          ) : (
            <KpiCard
              label="Fastest-growing video"
              value={null}
              unavailableReason="No growth data yet"
              updatedAt={updatedAt}
            />
          )}
        </div>

        {/* Performance trend */}
        <Card>
          <CardHeader
            title="Performance trend"
            subtitle={`Tracked totals over real snapshots · ${RANGE_LABELS[range]}`}
            action={<RangeSwitcher active={range} />}
          />
          <CardBody>
            {trendHasData && (
              <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <PeriodStat
                  label="Views gained"
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
                  label="Best platform today"
                  value={
                    momentum.bestPlatformToday
                      ? `${PLATFORM_LABELS[momentum.bestPlatformToday.platform]}`
                      : "—"
                  }
                  sub={
                    momentum.bestPlatformToday
                      ? `${formatDelta(momentum.bestPlatformToday.gained)} views`
                      : undefined
                  }
                />
                <PeriodStat
                  label="Fastest-growing video"
                  value={fastestTitle ? truncate(fastestTitle, 26) : "—"}
                  sub={
                    kpis.fastestGrowing
                      ? `${formatDelta(kpis.fastestGrowing.gained24h)} views`
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
                <div className="text-sm font-medium text-muted">Tracking just started</div>
                <div className="max-w-md text-xs text-muted-strong">
                  Metrics are captured every refresh. More trend history will appear after the next
                  few refreshes — the totals above are live now.
                </div>
              </div>
            ) : (
              <TrendChart data={data.trend} />
            )}
          </CardBody>
        </Card>

        {/* Platform comparison */}
        <section aria-label="Platform comparison">
          <SectionTitle className="mb-3">Platform comparison</SectionTitle>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.platformStats.map((s) => (
              <PlatformCard key={s.platform} stats={s} />
            ))}
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
