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
import { PlatformBadge } from "@/components/ui/platform";
import { TimeAgo } from "@/components/ui/time-ago";
import { VideoThumb } from "@/components/ui/video-thumb";
import { engagements } from "@/lib/metrics";
import type { Platform } from "@/lib/types";
import { ConceptPerformance, type ConceptRow } from "./concept-performance";

import { Expandable } from "./expandable";

export const dynamic = "force-dynamic";

function videoTitle(v: Video): string {
  return v.title?.trim() || v.caption?.trim() || "Untitled video";
}

export default async function EpisodesPage() {
  const [data, health] = await Promise.all([getEpisodesPageData(), getHealth()]);
  const { episodes, unassigned, allEpisodes } = data;

  const withVideos = episodes.filter((e) => e.videos.length > 0);
  const assignedCount = withVideos.reduce((sum, e) => sum + e.videos.length, 0);

  // Plain serializable rows for the client chart — per-platform totals are
  // real confirmed sums; no raw actor payloads cross to the client.
  const conceptRows: ConceptRow[] = [...withVideos]
    .sort((a, b) => (b.totalViews ?? -1) - (a.totalViews ?? -1))
    .map((e) => {
      const perPlatform: ConceptRow["perPlatform"] = {};
      for (const m of e.videos) {
        const p = m.video.platform as Platform;
        const views = m.confirmed.views?.value ?? null;
        const eng = m.latest ? engagements(m.latest) : null;
        if (views === null && eng === null) continue;
        const entry = perPlatform[p] ?? { views: 0, engagements: 0 };
        if (views !== null) entry.views += views;
        if (eng !== null) entry.engagements += eng;
        perPlatform[p] = entry;
      }
      const top = e.topVideo;
      return {
        id: e.episode.id,
        name: e.episode.name,
        videoCount: e.videos.length,
        perPlatform,
        totalViews: e.totalViews,
        totalEngagements: e.totalEngagements,
        totalComments: e.totalComments,
        engagementRate: e.avgEngagementRate,
        topPlatform: e.bestPlatform,
        topVideo: top
          ? {
              title: top.video.title ?? top.video.caption ?? "Untitled video",
              url: top.video.originalUrl,
              views: top.confirmed.views?.value ?? null,
            }
          : null,
      };
    });

  return (
    <div>
      <DataNotice health={health} />
      <PageHeader
        reveal
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
            subtitle="Stacked by platform — see exactly which channels drove each concept"
          />
          <CardBody>
            {conceptRows.length === 0 ? (
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
                    : "Assign videos to a concept in Admin → Episodes to compare cross-platform performance."
                }
              />
            ) : (
              <ConceptPerformance rows={conceptRows} />
            )}
          </CardBody>
        </Card>

        {/* Concept leaderboard — useful even when one concept dominates */}
        {conceptRows.length > 1 && (
          <Card>
            <CardHeader
              title="Concept leaderboard"
              subtitle="Every concept ranked by total confirmed views"
            />
            <CardBody className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wide text-muted-strong">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Concept</th>
                    <th className="py-2 pr-3 text-right font-medium">Views</th>
                    <th className="py-2 pr-3 text-right font-medium">Videos</th>
                    <th className="py-2 pr-3 font-medium">Top platform</th>
                    <th className="py-2 pr-3 text-right font-medium">ER</th>
                    <th className="py-2 font-medium">Best video</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {conceptRows.map((r, i) => (
                    <tr key={r.id} className="transition-colors hover:bg-surface-hover/40">
                      <td className="py-2 pr-3">
                        <span
                          className={
                            i === 0
                              ? "tabular flex h-5 w-5 items-center justify-center rounded-md bg-[var(--accent-soft)] text-[11px] font-bold text-accent"
                              : "tabular text-muted-strong"
                          }
                        >
                          {i + 1}
                        </span>
                      </td>
                      <td className="max-w-56 truncate py-2 pr-3 font-medium" title={r.name}>
                        {r.name}
                      </td>
                      <td className="tabular py-2 pr-3 text-right font-semibold">
                        {formatCompact(r.totalViews)}
                      </td>
                      <td className="tabular py-2 pr-3 text-right">{r.videoCount}</td>
                      <td className="py-2 pr-3">
                        {r.topPlatform ? <PlatformBadge platform={r.topPlatform} size="sm" /> : "—"}
                      </td>
                      <td className="tabular py-2 pr-3 text-right">
                        {r.engagementRate !== null ? formatPct(r.engagementRate) : "—"}
                      </td>
                      <td className="max-w-64 truncate py-2">
                        {r.topVideo ? (
                          <a
                            href={r.topVideo.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={r.topVideo.title}
                            className="text-muted transition-colors hover:text-accent"
                          >
                            {r.topVideo.title}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        )}

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
              <EpisodeCard key={stats.episode.id} stats={stats} />
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
                subtitle="Group these into concepts from Admin → Episodes so cross-platform totals stay accurate"
              />
              <CardBody>
                <ul className="divide-y divide-border">
                  {unassigned.map((m) => (
                    <VideoRow key={m.video.id} metrics={m} />
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

function EpisodeCard({ stats }: { stats: EpisodeStats }) {
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
            No videos assigned yet — manage assignments in{" "}
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
                    <VideoRow key={m.video.id} metrics={m} />
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

function VideoRow({ metrics }: { metrics: VideoMetrics }) {
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
    </li>
  );
}
