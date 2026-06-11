// Main campaign dashboard — the 30-second executive read on the
// Cybernick0x × Wachter creator campaign.

import clsx from "clsx";
import Link from "next/link";
import { getDashboardData, type TimeRange } from "@/lib/queries";
import { formatCompact, formatDate, formatDelta, formatNumber, formatPct, truncate } from "@/lib/format";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { PlatformBadge } from "@/components/ui/platform";
import { StatusPill } from "@/components/ui/status";
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

function SystemsIndicator({
  liveCount,
  total,
  anyFailed,
}: {
  liveCount: number;
  total: number;
  anyFailed: boolean;
}) {
  const allLive = total > 0 && liveCount === total;
  const tone = anyFailed
    ? { dot: "bg-negative", text: "text-negative", label: `Refresh failed (${liveCount}/${total} live)` }
    : allLive
      ? { dot: "bg-positive", text: "text-positive", label: "All systems live" }
      : { dot: "bg-warning", text: "text-warning", label: `Partially connected (${liveCount}/${total} live)` };
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium whitespace-nowrap",
        tone.text,
      )}
      role="status"
    >
      <span className={clsx("h-2 w-2 rounded-full", tone.dot, allLive && !anyFailed && "animate-pulse")} />
      {tone.label}
    </span>
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
  const lastRun = health.lastRun;
  const updatedAt = lastRun?.finishedAt ?? null;
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
            />
            <RefreshButton />
          </>
        }
      />

      {/* Per-platform connection status */}
      <div className="mb-6 flex flex-wrap gap-2">
        {health.platforms.map((p) => (
          <div
            key={p.platform}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5"
          >
            <PlatformBadge platform={p.platform} size="sm" />
            <StatusPill status={p.sourceStatus} detail={p.statusDetail} size="sm" />
          </div>
        ))}
      </div>

      <div className="space-y-6">
        {/* KPI grid */}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard
            label="Total views"
            value={kpis.totalViews !== null ? formatCompact(kpis.totalViews) : null}
            unavailableReason="No connected source yet"
            updatedAt={updatedAt}
          />
          <KpiCard
            label="Total engagements"
            value={kpis.totalEngagements !== null ? formatCompact(kpis.totalEngagements) : null}
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
            subtitle={`Cumulative views & engagements · ${RANGE_LABELS[range]}`}
            action={<RangeSwitcher active={range} />}
          />
          <CardBody>
            {trendHasData ? (
              <>
                <div className="mb-2 flex items-center gap-4 text-[11px] text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#3b82f6]" />
                    Views
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#34d399]" />
                    Engagements
                  </span>
                </div>
                <TrendChart data={data.trend} showEngagements />
              </>
            ) : (
              <EmptyState
                title="Waiting for first refresh"
                detail="The trend line draws itself as snapshots accumulate. Connect a provider and run a refresh to start capturing data."
              />
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
          <CommentIntelCard commentStats={commentStats} recentComments={data.recentComments} />
        </div>

        {/* Alerts preview */}
        <section aria-label="Open alerts">
          <AlertsPreview alerts={data.openAlerts} />
        </section>
      </div>
    </div>
  );
}
