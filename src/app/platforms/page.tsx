// Platform comparison — side-by-side performance across TikTok, YouTube
// Shorts, Instagram Reels, and Facebook Reels. Renders gracefully before any
// provider is connected: status pills explain *why* numbers are missing.

import { ExternalLink, TrendingUp } from "lucide-react";
import { getPlatformsPageData } from "@/lib/queries";
import type { PlatformStats } from "@/lib/queries";
import type { TrendPoint } from "@/lib/metrics";
import { PLATFORMS, PLATFORM_LABELS, type Platform, type Video } from "@/lib/types";
import { formatCompact, formatDate, formatNumber, formatPct, truncate } from "@/lib/format";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { PlatformBadge, PLATFORM_HEX } from "@/components/ui/platform";
import { StatusPill } from "@/components/ui/status";
import { DeltaTag } from "@/components/ui/delta";
import { TimeAgo } from "@/components/ui/time-ago";
import { EmptyState } from "@/components/ui/empty-state";
import { RefreshButton } from "@/components/ui/refresh-button";
import { PageHeader } from "@/components/layout/page-header";
import { DataNotice } from "@/components/layout/data-notice";
import { SimpleBarChart, type BarDatum } from "@/components/charts/bar-chart";
import { TrendChart } from "@/components/charts/trend-chart";
import { MultiTrendChart } from "@/components/charts/multi-trend-chart";

export const dynamic = "force-dynamic";

function hasTrendData(points: TrendPoint[]): boolean {
  return points.some((p) => p.views !== null || p.engagements !== null);
}

/** Single labeled metric inside a platform card body. */
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="tabular mt-0.5 truncate text-sm font-semibold text-foreground">{children}</div>
    </div>
  );
}

/** Footer row linking out to a notable post; renders a muted dash when absent. */
function PostLine({
  label,
  video,
  meta,
}: {
  label: string;
  video: Video | null;
  meta: string | null;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-2 text-xs">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {video ? (
        <>
          <a
            href={video.originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex min-w-0 items-center gap-1 truncate font-medium text-foreground transition-colors hover:text-accent"
          >
            <span className="truncate">
              {truncate(video.title ?? video.caption ?? "Untitled post", 52)}
            </span>
            <ExternalLink size={11} className="shrink-0 text-muted-strong group-hover:text-accent" />
          </a>
          {meta && <span className="tabular shrink-0 text-muted">{meta}</span>}
        </>
      ) : (
        <span className="text-muted-strong">—</span>
      )}
    </div>
  );
}

function PlatformCard({
  stats,
  statusDetail,
  commentCount,
  trend,
}: {
  stats: PlatformStats;
  statusDetail: string | null;
  commentCount: number;
  trend: TrendPoint[];
}) {
  const s = stats;
  const showTrend = hasTrendData(trend);
  // 0 collected comments on a not-yet-live source is "unknown", not a real zero.
  const commentVolume =
    commentCount > 0 ? formatCompact(commentCount) : s.sourceStatus === "live" ? "0" : "—";

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <PlatformBadge platform={s.platform} />
          <StatusPill status={s.sourceStatus} detail={statusDetail} size="sm" />
        </div>
        <div className="text-[11px] text-muted-strong">
          Last refresh: <TimeAgo iso={s.lastSuccessfulRefreshAt} />
        </div>
      </div>

      <CardBody className="pt-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3.5 sm:grid-cols-4">
          <Stat label="Total views">{formatCompact(s.views)}</Stat>
          <Stat label="Engagements">{formatCompact(s.engagements)}</Stat>
          <Stat label="Engagement rate">{formatPct(s.engagementRate)}</Stat>
          <Stat label="Avg views / video">{formatCompact(s.avgViewsPerVideo)}</Stat>
          <Stat label="Videos tracked">{formatNumber(s.videoCount)}</Stat>
          <Stat label="Comment volume">{commentVolume}</Stat>
          <Stat label="Views · 24h">
            <DeltaTag value={s.viewsGained24h} />
          </Stat>
          <Stat label="Comments · 24h">
            <DeltaTag value={s.commentsGained24h} />
          </Stat>
        </div>

        {showTrend && (
          <div className="mt-4 border-t border-border pt-3">
            <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted">
              <TrendingUp size={11} style={{ color: PLATFORM_HEX[s.platform] }} />
              Views · last 7 days
            </div>
            <TrendChart data={trend} height={120} mini />
          </div>
        )}

        <div className="mt-4 flex flex-col gap-1.5 border-t border-border pt-3">
          <PostLine
            label="Best post"
            video={s.bestVideo?.video ?? null}
            meta={s.bestVideo ? `${formatCompact(s.bestVideo.views)} views` : null}
          />
          <PostLine
            label="Latest post"
            video={s.latestVideo}
            meta={
              s.latestVideo
                ? formatDate(s.latestVideo.publishedAt ?? s.latestVideo.firstTrackedAt)
                : null
            }
          />
        </div>
      </CardBody>
    </Card>
  );
}

export default async function PlatformsPage() {
  const { campaign, health, stats, trendByPlatform, commentCounts } = await getPlatformsPageData();

  const statsByPlatform = new Map(stats.map((s) => [s.platform, s]));
  const ordered = PLATFORMS.map((p) => statsByPlatform.get(p)).filter(
    (s): s is PlatformStats => Boolean(s),
  );
  const detailByPlatform = new Map(health.platforms.map((p) => [p.platform, p.statusDetail]));

  const viewsBars: BarDatum[] = ordered.map((s) => ({
    name: PLATFORM_LABELS[s.platform],
    value: s.views,
    color: PLATFORM_HEX[s.platform],
  }));
  const engagementBars: BarDatum[] = ordered.map((s) => ({
    name: PLATFORM_LABELS[s.platform],
    value: s.engagementRate,
    color: PLATFORM_HEX[s.platform],
  }));

  const anyTrend = (Object.keys(trendByPlatform) as Platform[]).some((p) =>
    hasTrendData(trendByPlatform[p] ?? []),
  );

  return (
    <div className="mx-auto w-full max-w-7xl">
      <DataNotice health={health} />
      <PageHeader
        title="Platforms"
        subtitle={`${campaign.creatorName} × ${campaign.company} — side-by-side performance across all four networks`}
        actions={<RefreshButton />}
      />

      {/* Comparison charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Views by platform" subtitle="Latest total views per network" />
          <CardBody>
            <SimpleBarChart data={viewsBars} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Engagement rate"
            subtitle="Engagements ÷ views — gray bars mean the platform didn't expose the data"
          />
          <CardBody>
            <SimpleBarChart data={engagementBars} valueKind="percent" />
          </CardBody>
        </Card>
      </div>

      {/* Cross-platform trend */}
      <div className="mt-4">
        {anyTrend ? (
          <Card>
            <CardHeader
              title="Views over time by platform"
              subtitle="Cumulative tracked views, last 7 days"
            />
            <CardBody>
              <MultiTrendChart trendByPlatform={trendByPlatform} />
            </CardBody>
          </Card>
        ) : (
          <EmptyState
            icon={<TrendingUp size={22} />}
            title="No trend data yet"
            detail="Views over time will appear here once the first metric snapshots are captured. Trigger a refresh or connect a provider in Admin to start tracking."
          />
        )}
      </div>

      {/* Per-platform detail */}
      <div className="mt-8">
        <SectionTitle className="mb-4">Platform detail</SectionTitle>
        <div className="grid gap-4 md:grid-cols-2">
          {ordered.map((s) => (
            <PlatformCard
              key={s.platform}
              stats={s}
              statusDetail={detailByPlatform.get(s.platform) ?? null}
              commentCount={commentCounts[s.platform] ?? 0}
              trend={trendByPlatform[s.platform] ?? []}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
