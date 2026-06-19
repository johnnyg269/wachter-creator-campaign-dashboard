// Main campaign dashboard — the 30-second executive read on the
// Cybernick0x × Wachter creator campaign.
//
// Phase 3.7 composition — a command center, not a card grid:
//   1. Cinematic hero band: narrative left, live performance panel right
//   2. Editorial KPI strip (one connected band, hairline-divided)
//   3. Campaign Momentum centerpiece (glow panel + insight rail)
//   4. "What's happening now" story strip
//   5. Top videos (featured #1 + ranked list)
//   6. Platform leaderboard (ranked rows + share bars)
//   7. Audience signals + velocity
//   8. Data status drawer (operational truth, one click away)

import clsx from "clsx";
import Link from "next/link";
import { MessagesSquare, Sparkles, TrendingUp } from "lucide-react";
import { getDashboardData, dashboardMilestoneInput, type TimeRange } from "@/lib/queries";
import { PLATFORM_LABELS, type Platform } from "@/lib/types";
import type { TrendPoint } from "@/lib/metrics";
import {
  formatCompact,
  formatDate,
  formatDelta,
  formatNumber,
  formatPct,
  truncate,
} from "@/lib/format";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CountUp } from "@/components/ui/count-up";
import { AnimatedText } from "@/components/ui/animated-text";
import { EmptyState } from "@/components/ui/empty-state";
import { VideoThumb } from "@/components/ui/video-thumb";
import { AutoRefreshNote } from "@/components/ui/auto-refresh-note";
import { DataNotice } from "@/components/layout/data-notice";
import { MomentumChart } from "@/components/charts/momentum-chart";
import { RangeSwitcher } from "@/components/dashboard/range-switcher";
import { Leaderboard } from "@/components/dashboard/leaderboard";
import { FeaturedVideo } from "@/components/dashboard/featured-video";
import { PlatformLeaderboard } from "@/components/dashboard/platform-leaderboard";
import { CampaignMilestones } from "@/components/dashboard/milestones";
import { computeMilestones, selectTopMilestones } from "@/lib/milestones";
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

/** True when the most recent reading jumped well above the average step. */
function isAccelerating(trend: TrendPoint[]): boolean {
  const views = trend.map((p) => p.views).filter((v): v is number => v !== null);
  if (views.length < 4) return false;
  const gains: number[] = [];
  for (let i = 1; i < views.length; i++) gains.push(views[i] - views[i - 1]);
  const positive = gains.filter((g) => g > 0);
  if (positive.length === 0) return false;
  const avg = positive.reduce((a, b) => a + b, 0) / positive.length;
  const lastGain = gains[gains.length - 1];
  return lastGain > 0 && lastGain >= avg * 1.5;
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
  const refreshRunning = lastRun?.status === "running";
  const trendHasData = data.trend.some((p) => p.views !== null);

  const shares = growthShares(data.trendByPlatform);
  const leader = shares[0] ?? null;
  const accelerating = trendHasData && !data.trendIsSparse && isAccelerating(data.trend);
  const coverage = coverageNote(range, data.historyStart);

  // Platform standings (by total confirmed views).
  const totalPlatformViews = data.platformStats.reduce((a, s) => a + (s.views ?? 0), 0);
  const platformsRanked = [...data.platformStats]
    .filter((s) => s.views !== null)
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
  const topPlatform = platformsRanked[0] ?? null;
  const topPlatformShare =
    topPlatform && totalPlatformViews > 0
      ? Math.round(((topPlatform.views ?? 0) / totalPlatformViews) * 100)
      : null;

  // Campaign milestones — REAL achievements from the latest snapshot, top 3–5.
  // Computed via the shared engine input (identical to admin diagnostics).
  // Dynamic-only (no persisted "first crossed" dates).
  const milestones = selectTopMilestones(
    computeMilestones(dashboardMilestoneInput(data, RANGE_LABELS[range].toLowerCase())),
    5,
  );

  // Editorial momentum headline — real data only.
  const momentumHeadline = !trendHasData
    ? "Campaign momentum"
    : accelerating
      ? "The campaign is accelerating"
      : data.periodDelta.views !== null && data.periodDelta.views > 0
        ? `${formatDelta(data.periodDelta.views)} views ${RANGE_LABELS[range].toLowerCase()}`
        : "Campaign momentum";
  const momentumSub = [
    accelerating && data.periodDelta.views !== null && data.periodDelta.views > 0
      ? `${formatDelta(data.periodDelta.views)} views ${RANGE_LABELS[range].toLowerCase()}`
      : null,
    leader ? `${PLATFORM_LABELS[leader.platform]} drove ${leader.pct}% of growth` : null,
    refreshRunning ? "refresh in progress" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // "What's happening now" — editorial sentences from real computed values.
  const story: Array<{ icon: React.ReactNode; text: string }> = [];
  if (topPlatform && topPlatformShare !== null) {
    story.push({
      icon: <TrendingUp size={13} />,
      text: `${PLATFORM_LABELS[topPlatform.platform]} is driving ${topPlatformShare}% of total campaign views (${formatCompact(topPlatform.views)})`,
    });
  }
  if (kpis.viewsGained24h !== null && kpis.viewsGained24h > 0) {
    story.push({
      icon: <Sparkles size={13} />,
      text: `The campaign gained ${formatDelta(kpis.viewsGained24h)} views in the last 24 hours`,
    });
  }
  if (data.periodFastestGrowing) {
    story.push({
      icon: <TrendingUp size={13} />,
      text: `Fastest-growing post gained ${formatDelta(data.periodFastestGrowing.gained)} views ${RANGE_LABELS[range].toLowerCase()}: “${truncate(data.periodFastestGrowing.video.title ?? data.periodFastestGrowing.video.caption ?? "Untitled", 60)}”`,
    });
  }
  if (commentStats.needsResponse > 0) {
    story.push({
      icon: <MessagesSquare size={13} />,
      text: `${formatNumber(commentStats.needsResponse)} audience ${commentStats.needsResponse === 1 ? "comment" : "comments"} may deserve a response`,
    });
  }
  story.push({
    icon: <Sparkles size={13} />,
    text: `${formatNumber(kpis.videosTracked)} videos tracked across ${liveCount} live platforms · ${kpis.avgEngagementRate !== null ? `${formatPct(kpis.avgEngagementRate)} average engagement rate` : "engagement rate building"}`,
  });

  return (
    <div>
      <DataNotice health={health} />

      {/* ── 1 · Hero band — narrative left, live performance panel right ── */}
      <section className="hero-band section-enter mb-5 px-6 py-6 lg:px-8 lg:py-7">
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-x-10 gap-y-6">
          <div className="min-w-[260px] max-w-xl flex-1">
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-accent">
              Campaign performance
            </div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight lg:text-4xl">
              Cybernick0x × Wachter
            </h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">
              Cross-platform creator campaign
              {data.dateRange.from ? ` · running since ${formatDate(data.dateRange.from)}` : ""} ·
              one shared live view across TikTok, YouTube Shorts, Instagram Reels, and Facebook
              Reels.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
              {/* Operational status only — the refresh note carries liveness +
                  next-refresh timing. No executive-useless "confidence" copy. */}
              <AutoRefreshNote variant="inline" />
            </div>
          </div>

          {/* Live performance panel */}
          <div className="min-w-[260px]">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-strong">
              Total campaign views
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="tabular-nums text-5xl font-bold leading-none tracking-tighter lg:text-6xl">
                {kpis.totalViews !== null ? (
                  <AnimatedText text={formatCompact(kpis.totalViews)} rollOnMount />
                ) : (
                  "—"
                )}
              </span>
              {kpis.viewsGained24h !== null && kpis.viewsGained24h > 0 && (
                <span className="tabular-nums text-base font-semibold text-positive">
                  <AnimatedText text={formatDelta(kpis.viewsGained24h)} />
                  <span className="ml-1 text-[11px] font-medium text-positive/70">24h</span>
                </span>
              )}
            </div>
            {/* Exact total beneath the shortened hero number — real current
                snapshot total, comma-formatted, quiet (never competes with the
                big number; intentionally not animated). */}
            {kpis.totalViews !== null && (
              <div className="tabular-nums mt-1.5 text-[12px] text-muted-strong">
                {formatNumber(kpis.totalViews)} total views
              </div>
            )}
            {/* Platform share strip */}
            {totalPlatformViews > 0 && (
              <div className="mt-4">
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-hover">
                  {platformsRanked.map((s) => (
                    <div
                      key={s.platform}
                      className="bar-fill h-full"
                      style={{
                        width: `${Math.max(2, ((s.views ?? 0) / totalPlatformViews) * 100)}%`,
                        background: PLATFORM_HEX[s.platform],
                        opacity: 0.9,
                      }}
                      title={`${PLATFORM_LABELS[s.platform]}: ${formatCompact(s.views)} views`}
                    />
                  ))}
                </div>
                {topPlatform && topPlatformShare !== null && (
                  <div className="mt-1.5 text-[11px] text-muted">
                    <span
                      aria-hidden
                      className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                      style={{ background: PLATFORM_HEX[topPlatform.platform] }}
                    />
                    <AnimatedText
                      text={`${PLATFORM_LABELS[topPlatform.platform]} leads with ${topPlatformShare}% of views`}
                      className="align-middle"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="space-y-5">
        {/* ── 2 · Editorial KPI strip — one band, hairline-divided ── */}
        <section
          className="section-enter grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-surface/70 lg:grid-cols-4"
          style={{ animationDelay: "60ms" }}
          aria-label="Key metrics"
        >
          {[
            {
              label: "24h growth",
              node:
                kpis.viewsGained24h !== null ? (
                  <CountUp value={kpis.viewsGained24h} format="delta" className="text-positive" />
                ) : (
                  <span className="text-muted-strong">—</span>
                ),
              sub: "new views in the last day",
            },
            {
              label: "Engagements",
              node:
                kpis.totalEngagements !== null ? (
                  <CountUp value={kpis.totalEngagements} />
                ) : (
                  <span className="text-muted-strong">—</span>
                ),
              sub:
                data.periodDelta.engagements !== null && data.periodDelta.engagements > 0
                  ? `${formatDelta(data.periodDelta.engagements)} this period`
                  : "likes + comments + shares",
            },
            {
              label: "Comments captured",
              node:
                kpis.totalComments !== null ? (
                  <CountUp value={kpis.totalComments} />
                ) : (
                  <span className="text-muted-strong">—</span>
                ),
              sub: `${formatNumber(commentStats.needsResponse)} awaiting a reply`,
            },
            {
              label: "Top platform",
              node: topPlatform ? PLATFORM_LABELS[topPlatform.platform] : "—",
              sub:
                topPlatform && topPlatformShare !== null
                  ? `${topPlatformShare}% of campaign views`
                  : "no confirmed views yet",
            },
          ].map((stat, i) => (
            <div
              key={stat.label}
              className={clsx(
                "px-5 py-4",
                i > 0 && "border-l border-border max-lg:[&:nth-child(3)]:border-l-0",
                i >= 2 && "max-lg:border-t max-lg:border-border",
              )}
            >
              <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-strong">
                {stat.label}
              </div>
              <div className="tabular-nums mt-1.5 text-2xl font-bold leading-none tracking-tight">
                {stat.node}
              </div>
              <div className="mt-1.5 truncate text-[11px] text-muted">{stat.sub}</div>
            </div>
          ))}
        </section>

        {/* ── 3 · Campaign Momentum — the centerpiece ── */}
        <section
          className="momentum-panel section-enter px-5 pb-5 pt-4 lg:px-6"
          style={{ animationDelay: "120ms" }}
          aria-label="Campaign momentum"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex flex-wrap items-baseline gap-x-3 text-lg font-bold tracking-tight">
                {momentumHeadline}
                {accelerating && (
                  <span className="rounded-full border border-positive/30 bg-[rgba(52,211,153,0.08)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-positive">
                    Growth surge
                  </span>
                )}
              </h2>
              {(momentumSub || coverage) && (
                <p className="mt-1 text-xs text-muted">
                  {momentumSub}
                  {momentumSub && coverage && <span aria-hidden> · </span>}
                  {coverage && <span className="text-muted-strong">{coverage}</span>}
                </p>
              )}
            </div>
            <RangeSwitcher active={range} />
          </div>

          <div className="mt-4">
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
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_250px]">
                <MomentumChart
                  data={data.trend}
                  byPlatform={data.trendByPlatform}
                  height={380}
                  range={range}
                />

                {/* Insight rail — hairline-divided, no boxes-in-boxes */}
                <div className="flex flex-col divide-y divide-border lg:pl-6 lg:[border-left:1px_solid_var(--border)]">
                  <div className="pb-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-strong">
                      Views gained · {RANGE_LABELS[range].toLowerCase()}
                    </div>
                    <div
                      className={clsx(
                        "tabular-nums mt-1 text-2xl font-bold tracking-tight",
                        (data.periodDelta.views ?? 0) > 0 ? "text-positive" : "text-foreground",
                      )}
                    >
                      {data.periodDelta.views !== null
                        ? formatDelta(data.periodDelta.views)
                        : "—"}
                    </div>
                  </div>
                  <div className="py-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-strong">
                      Engagements gained
                    </div>
                    <div className="tabular-nums mt-1 text-xl font-bold tracking-tight">
                      {data.periodDelta.engagements !== null
                        ? formatDelta(data.periodDelta.engagements)
                        : "—"}
                    </div>
                  </div>
                  <div className="py-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-strong">
                      Growth leaders · {RANGE_LABELS[range].toLowerCase()}
                    </div>
                    {data.growthLeaders.length > 0 ? (
                      <ul className="mt-2 space-y-2">
                        {data.growthLeaders.map((g, i) => {
                          const title = g.video.title ?? g.video.caption ?? "Untitled video";
                          return (
                            <li key={g.video.id} className="flex items-center gap-2.5">
                              <VideoThumb
                                src={g.video.thumbnailUrl}
                                platform={g.video.platform}
                                alt={title}
                                className="h-9 w-7 shrink-0 rounded"
                              />
                              <div className="min-w-0 flex-1">
                                <a
                                  href={g.video.originalUrl}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={title}
                                  className={clsx(
                                    "block truncate text-xs transition-colors hover:text-accent",
                                    i === 0 ? "font-semibold" : "font-medium text-foreground/85",
                                  )}
                                >
                                  {truncate(title, 34)}
                                </a>
                                <div className="tabular-nums text-[10px] text-muted-strong">
                                  <span className="text-positive">{formatDelta(g.gained)}</span>
                                  {" · "}
                                  {g.sharePct}% of growth
                                  {g.currentViews !== null && (
                                    <> · {formatCompact(g.currentViews)} total</>
                                  )}
                                </div>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <div className="mt-1 text-xs text-muted-strong">
                        Needs two confirmed readings in range
                      </div>
                    )}
                  </div>
                  {shares.length > 0 && (
                    <div className="pt-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-strong">
                        Growth by platform
                      </div>
                      <div className="mt-2.5 space-y-2.5">
                        {shares.map((s) => (
                          <div key={s.platform}>
                            <div className="flex items-baseline justify-between text-[11px]">
                              <span className="text-muted">{PLATFORM_LABELS[s.platform]}</span>
                              <span className="tabular-nums font-semibold">
                                {formatDelta(s.gained)}
                                <span className="ml-1 font-normal text-muted-strong">
                                  {s.pct}%
                                </span>
                              </span>
                            </div>
                            <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-hover">
                              <div
                                className="bar-fill h-full rounded-full"
                                style={{
                                  width: `${Math.max(2, s.pct)}%`,
                                  background: PLATFORM_HEX[s.platform],
                                  opacity: 0.9,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* ── 3.5 · Campaign milestones — real achievements, compact ── */}
        {milestones.length > 0 && (
          <CampaignMilestones milestones={milestones} />
        )}

        {/* ── 4 · What's happening now — editorial story strip ── */}
        {story.length > 0 && (
          <section
            className="section-enter rounded-2xl border border-border bg-surface/70 px-5 py-4 lg:px-6"
            style={{ animationDelay: "180ms" }}
            aria-label="Campaign story"
          >
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-strong">
              What’s happening now
            </div>
            <ul className="mt-2.5 grid gap-x-8 gap-y-2 lg:grid-cols-2">
              {story.slice(0, 6).map((line) => (
                <li
                  key={line.text}
                  className="flex items-start gap-2.5 text-[13px] leading-snug text-foreground/90"
                >
                  <span aria-hidden className="mt-0.5 shrink-0 text-accent">
                    {line.icon}
                  </span>
                  {line.text}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── 5 · Top videos — featured #1 + ranked list ── */}
        <div className="section-enter" style={{ animationDelay: "240ms" }}>
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
              {data.leaderboard.mostViewed[0] && (
                <FeaturedVideo m={data.leaderboard.mostViewed[0]} />
              )}
              <Leaderboard leaderboard={data.leaderboard} />
            </CardBody>
          </Card>
        </div>

        {/* ── 6 · Platform leaderboard ── */}
        <section
          aria-label="Platform comparison"
          className="section-enter"
          style={{ animationDelay: "300ms" }}
        >
          <Card>
            <CardHeader
              title="Platform standings"
              subtitle="Ranked by confirmed views · share of the whole campaign"
              action={
                <Link
                  href="/platforms"
                  className="shrink-0 text-xs font-medium text-accent transition-colors hover:underline"
                >
                  Platform detail →
                </Link>
              }
            />
            <CardBody>
              <PlatformLeaderboard stats={data.platformStats} />
            </CardBody>
          </Card>
        </section>

        {/* ── 7 · Audience signals + velocity ── */}
        <div
          className="section-enter grid grid-cols-1 gap-4 lg:grid-cols-2"
          style={{ animationDelay: "360ms" }}
        >
          <CommentIntelCard
            commentStats={commentStats}
            recentComments={data.recentComments}
            responseOpportunities={data.responseOpportunities}
          />
          <MomentumCard momentum={momentum} />
        </div>

        {/* ── 8 · Operational truth — honest, complete, one click away ── */}
        <DataStatusDrawer
          health={health}
          capabilities={data.sourceCapabilities}
          liveCount={liveCount}
          anyFailed={anyFailed}
          hasGaps={hasGaps}
          delayed={anyDelayed}
        />

        <section aria-label="Open alerts">
          <AlertsPreview alerts={data.openAlerts} />
        </section>
      </div>
    </div>
  );
}
