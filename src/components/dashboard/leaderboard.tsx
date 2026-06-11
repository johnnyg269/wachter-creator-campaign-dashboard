// Top-videos leaderboard: five tabbed rankings sharing one row layout.
// Server component — tab contents are rendered on the server and handed to the
// client Tabs shell as ReactNodes.

import type { VideoMetrics } from "@/lib/metrics";
import type { DashboardData } from "@/lib/queries";
import { Tabs } from "@/components/ui/tabs";
import { VideoThumb } from "@/components/ui/video-thumb";
import { PlatformBadge } from "@/components/ui/platform";
import { DeltaTag } from "@/components/ui/delta";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatPct, truncate } from "@/lib/format";
import { MetricValue } from "@/components/ui/metric-value";

function videoTitle(m: VideoMetrics): string {
  return m.video.title ?? m.video.caption ?? "Untitled video";
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="w-16 text-right">
      <div className="tabular text-sm font-medium">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-strong">{label}</div>
    </div>
  );
}

function LeaderboardRow({ m, rank }: { m: VideoMetrics; rank: number }) {
  const title = videoTitle(m);
  return (
    <li className="flex items-center gap-3 py-2.5">
      <span className="tabular w-5 shrink-0 text-right text-xs font-semibold text-muted-strong">
        {rank}
      </span>
      <VideoThumb
        src={m.video.thumbnailUrl}
        platform={m.video.platform}
        alt={title}
        className="h-12 w-9 shrink-0"
      />
      <div className="min-w-0 flex-1">
        <a
          href={m.video.originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className="block truncate text-sm font-medium transition-colors hover:text-accent"
        >
          {truncate(title, 90)}
        </a>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <PlatformBadge platform={m.video.platform} size="sm" />
          <span className="text-[11px] text-muted-strong">
            {m.video.publishedAt ? formatDate(m.video.publishedAt) : "Publish date unknown"}
          </span>
          {/* Compact metrics shown only on small screens */}
          <span className="tabular text-[11px] text-muted md:hidden">
            <MetricValue confirmed={m.confirmed.views} hasAnySnapshot={m.latest !== null} /> views
          </span>
          <DeltaTag value={m.delta24h?.value ?? null} label="24h" className="md:hidden" />
        </div>
      </div>
      <div className="hidden shrink-0 items-center gap-4 md:flex">
        <Metric
          label="Views"
          value={<MetricValue confirmed={m.confirmed.views} hasAnySnapshot={m.latest !== null} />}
        />
        <Metric
          label="Likes"
          value={<MetricValue confirmed={m.confirmed.likes} hasAnySnapshot={m.latest !== null} />}
        />
        <Metric
          label="Comments"
          value={<MetricValue confirmed={m.confirmed.comments} hasAnySnapshot={m.latest !== null} />}
        />
        <Metric label="ER" value={formatPct(m.engagementRate)} />
        <div className="w-16 text-right">
          <DeltaTag value={m.delta24h?.value ?? null} label="24h" />
        </div>
      </div>
    </li>
  );
}

function LeaderboardList({
  items,
  emptyTitle,
  emptyDetail,
}: {
  items: VideoMetrics[];
  emptyTitle: string;
  emptyDetail: string;
}) {
  if (items.length === 0) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  }
  return (
    <ul className="divide-y divide-border">
      {items.map((m, i) => (
        <LeaderboardRow key={m.video.id} m={m} rank={i + 1} />
      ))}
    </ul>
  );
}

export function Leaderboard({ leaderboard }: { leaderboard: DashboardData["leaderboard"] }) {
  return (
    <Tabs
      tabs={[
        {
          key: "most-viewed",
          label: "Most viewed",
          content: (
            <LeaderboardList
              items={leaderboard.mostViewed}
              emptyTitle="Waiting for first refresh"
              emptyDetail="Videos will rank here as soon as view counts are captured."
            />
          ),
        },
        {
          key: "fastest-growing",
          label: "Fastest growing",
          content: (
            <LeaderboardList
              items={leaderboard.fastestGrowing}
              emptyTitle="No growth data yet"
              emptyDetail="Growth needs at least two snapshots per video — check back after the next refresh."
            />
          ),
        },
        {
          key: "highest-engagement",
          label: "Highest engagement",
          content: (
            <LeaderboardList
              items={leaderboard.highestEngagement}
              emptyTitle="No engagement data yet"
              emptyDetail="Engagement rate needs views plus likes/comments from a connected source."
            />
          ),
        },
        {
          key: "most-commented",
          label: "Most commented",
          content: (
            <LeaderboardList
              items={leaderboard.mostCommented}
              emptyTitle="No comment counts yet"
              emptyDetail="Comment totals appear once a comments-capable provider runs."
            />
          ),
        },
        {
          key: "newest",
          label: "Newest",
          content: (
            <LeaderboardList
              items={leaderboard.newest}
              emptyTitle="No videos tracked yet"
              emptyDetail="Add seed URLs in Admin or run a refresh to discover posts."
            />
          ),
        },
      ]}
    />
  );
}
