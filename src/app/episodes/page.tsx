// Episode / concept tracker: the same content concept (e.g. "Bootcamp") is
// posted across platforms — this page compares concepts cross-platform.

import Link from "next/link";
import { Layers, ListVideo } from "lucide-react";

import { getEpisodesPageData, getHealth, type EpisodeStats } from "@/lib/queries";
import type { Video } from "@/lib/types";
import type { VideoMetrics } from "@/lib/metrics";
import { formatCompact, formatDate, formatPct, truncate } from "@/lib/format";

import { PageHeader } from "@/components/layout/page-header";
import { DataNotice } from "@/components/layout/data-notice";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { DeltaTag } from "@/components/ui/delta";
import { EmptyState } from "@/components/ui/empty-state";
import { PlatformBadge, PLATFORM_HEX } from "@/components/ui/platform";
import { TimeAgo } from "@/components/ui/time-ago";
import { VideoThumb } from "@/components/ui/video-thumb";
import { SimpleBarChart, type BarDatum } from "@/components/charts/bar-chart";

import { AssignEpisodeSelect, type EpisodeOption } from "./assign-episode-select";
import { Expandable } from "./expandable";

export const dynamic = "force-dynamic";

function videoTitle(v: Video): string {
  return v.title?.trim() || v.caption?.trim() || "Untitled video";
}

export default async function EpisodesPage() {
  const [data, health] = await Promise.all([getEpisodesPageData(), getHealth()]);
  const { episodes, unassigned, allEpisodes } = data;

  const episodeOptions: EpisodeOption[] = allEpisodes.map((e) => ({ id: e.id, name: e.name }));
  const withVideos = episodes.filter((e) => e.videos.length > 0);
  const assignedCount = withVideos.reduce((sum, e) => sum + e.videos.length, 0);

  const chartRows: BarDatum[] = [...withVideos]
    .sort((a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1))
    .map((e) => ({
      name: e.episode.name,
      value: e.totalViews,
      color: e.bestPlatform ? PLATFORM_HEX[e.bestPlatform] : undefined,
    }));

  return (
    <div>
      <DataNotice health={health} />
      <PageHeader
        title="Episodes"
        subtitle="Cross-platform performance by content concept"
        actions={
          <div className="tabular text-xs text-muted">
            {episodes.length} {episodes.length === 1 ? "concept" : "concepts"} · {assignedCount}{" "}
            assigned · {unassigned.length} unassigned
          </div>
        }
      />

      <div className="space-y-6">
        {/* Episode performance chart */}
        <Card>
          <CardHeader
            title="Episode performance"
            subtitle="Total views per concept across all platforms — bars take the color of the concept's best platform"
          />
          <CardBody>
            {chartRows.length === 0 ? (
              <EmptyState
                icon={<Layers size={20} />}
                title={
                  allEpisodes.length === 0
                    ? "No episodes yet"
                    : "No episode has videos yet"
                }
                detail={
                  allEpisodes.length === 0
                    ? "Create episode concepts in Admin, then assign videos to compare the same content across platforms."
                    : "Assign videos to a concept below (or in Admin) to compare cross-platform performance."
                }
              />
            ) : (
              <SimpleBarChart
                data={chartRows}
                layout="vertical"
                height={Math.max(180, chartRows.length * 44 + 40)}
              />
            )}
          </CardBody>
        </Card>

        {/* Episode cards */}
        {episodes.length === 0 ? (
          <EmptyState
            icon={<Layers size={20} />}
            title="No episode concepts defined"
            detail="Episodes group the same content posted across TikTok, YouTube Shorts, Instagram Reels, and Facebook Reels. Create them in Admin."
            action={
              <Link
                href="/admin"
                className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors hover:border-border-strong hover:bg-surface-hover"
              >
                Open Admin
              </Link>
            }
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {episodes.map((stats) => (
              <EpisodeCard key={stats.episode.id} stats={stats} episodeOptions={episodeOptions} />
            ))}
          </div>
        )}

        {/* Unassigned videos */}
        <section aria-labelledby="unassigned-videos">
          <SectionTitle className="mb-3">
            <span id="unassigned-videos">Unassigned videos</span>
          </SectionTitle>
          {unassigned.length === 0 ? (
            <EmptyState
              icon={<ListVideo size={20} />}
              title="Every tracked video is assigned"
              detail="New videos discovered on the next refresh will appear here until they are grouped into a concept."
            />
          ) : (
            <Card>
              <CardHeader
                title={`${unassigned.length} ${unassigned.length === 1 ? "video" : "videos"} without a concept`}
                subtitle="Assign each one to an episode so cross-platform totals stay accurate"
              />
              <CardBody>
                <ul className="divide-y divide-border">
                  {unassigned.map((m) => (
                    <VideoRow
                      key={m.video.id}
                      metrics={m}
                      currentEpisodeId={null}
                      episodeOptions={episodeOptions}
                      placeholder="Assign to episode…"
                    />
                  ))}
                </ul>
              </CardBody>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Episode card (server component)
// ---------------------------------------------------------------------------

function EpisodeCard({
  stats,
  episodeOptions,
}: {
  stats: EpisodeStats;
  episodeOptions: EpisodeOption[];
}) {
  const { episode, videos } = stats;
  const lastRefreshed =
    videos
      .map((m) => m.video.lastRefreshedAt)
      .filter((t): t is string => t !== null)
      .sort()
      .reverse()[0] ?? null;

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={episode.name}
        subtitle={episode.description ? truncate(episode.description, 100) : undefined}
        action={
          <div className="flex flex-col items-end gap-1">
            <span className="tabular whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-medium text-muted">
              {videos.length} {videos.length === 1 ? "video" : "videos"}
            </span>
            {lastRefreshed && (
              <span className="whitespace-nowrap text-[10px] text-muted-strong">
                Updated <TimeAgo iso={lastRefreshed} />
              </span>
            )}
          </div>
        }
      />
      <CardBody className="flex flex-1 flex-col gap-4">
        {videos.length === 0 ? (
          <p className="text-xs text-muted-strong">
            No videos assigned yet — assign below or in{" "}
            <Link href="/admin" className="text-muted underline underline-offset-2 hover:text-foreground">
              /admin
            </Link>
            .
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Views" value={formatCompact(stats.totalViews)} />
              <Stat label="Engagements" value={formatCompact(stats.totalEngagements)} />
              <Stat label="Comments" value={formatCompact(stats.totalComments)} />
              <Stat label="Avg ER" value={formatPct(stats.avgEngagementRate)} />
            </dl>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
              <span className="flex items-center gap-1.5">
                <span className="text-muted-strong">24h</span>
                <DeltaTag value={stats.views24h ?? null} label="views" />
              </span>
              <span className="flex items-center gap-1.5">
                <span className="text-muted-strong">Best platform</span>
                {stats.bestPlatform ? (
                  <PlatformBadge platform={stats.bestPlatform} size="sm" />
                ) : (
                  <span className="text-muted-strong">—</span>
                )}
              </span>
              <span className="flex items-center gap-1.5 text-muted">
                <span className="text-muted-strong">Newest post</span>
                {formatDate(stats.newestPostAt)}
              </span>
            </div>

            {stats.topVideo && <TopVideo metrics={stats.topVideo} />}

            <div className="mt-auto">
              <Expandable label={`Videos (${videos.length})`}>
                <ul className="divide-y divide-border">
                  {videos.map((m) => (
                    <VideoRow
                      key={m.video.id}
                      metrics={m}
                      currentEpisodeId={episode.id}
                      episodeOptions={episodeOptions}
                      placeholder="Move to…"
                    />
                  ))}
                </ul>
              </Expandable>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">{label}</dt>
      <dd className="tabular mt-0.5 text-base font-semibold tracking-tight">{value}</dd>
    </div>
  );
}

function TopVideo({ metrics }: { metrics: VideoMetrics }) {
  const v = metrics.video;
  const views = metrics.latest?.views ?? null;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
      <VideoThumb src={v.thumbnailUrl} platform={v.platform} alt={videoTitle(v)} className="h-12 w-9" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">
          Top video
        </div>
        <a
          href={v.originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-xs font-medium transition-colors hover:text-accent"
          title={videoTitle(v)}
        >
          {videoTitle(v)}
        </a>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <PlatformBadge platform={v.platform} size="sm" />
          <span className="tabular">{views !== null ? `${formatCompact(views)} views` : "Views unavailable"}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared video row (member lists + unassigned list)
// ---------------------------------------------------------------------------

function VideoRow({
  metrics,
  currentEpisodeId,
  episodeOptions,
  placeholder,
}: {
  metrics: VideoMetrics;
  currentEpisodeId: string | null;
  episodeOptions: EpisodeOption[];
  placeholder: string;
}) {
  const v = metrics.video;
  const title = videoTitle(v);
  const views = metrics.latest?.views ?? null;
  return (
    <li className="flex items-center gap-3 py-2.5">
      <VideoThumb src={v.thumbnailUrl} platform={v.platform} alt={title} className="h-11 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <PlatformBadge platform={v.platform} size="sm" />
          <a
            href={v.originalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 truncate text-xs font-medium transition-colors hover:text-accent"
            title={title}
          >
            {title}
          </a>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
          <span className="tabular">{views !== null ? `${formatCompact(views)} views` : "Views —"}</span>
          <span className="tabular">
            {metrics.engagementRate !== null ? `${formatPct(metrics.engagementRate)} ER` : "ER —"}
          </span>
          <span className="text-muted-strong">
            {v.lastRefreshedAt ? (
              <>
                Updated <TimeAgo iso={v.lastRefreshedAt} />
              </>
            ) : (
              "Awaiting first refresh"
            )}
          </span>
        </div>
      </div>
      <AssignEpisodeSelect
        videoId={v.id}
        currentEpisodeId={currentEpisodeId}
        episodes={episodeOptions}
        placeholder={placeholder}
        ariaLabel={
          currentEpisodeId
            ? `Move ${title} to another episode`
            : `Assign ${title} to an episode`
        }
        className="shrink-0"
      />
    </li>
  );
}
