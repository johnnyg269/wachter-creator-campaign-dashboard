// One platform-comparison card. Every metric is null-safe — null renders as
// "—" (the platform didn't expose it), never as a fake zero.

import type { PlatformStats } from "@/lib/queries";
import { Card } from "@/components/ui/card";
import { PlatformBadge } from "@/components/ui/platform";
import { StatusPill } from "@/components/ui/status";
import { DeltaTag } from "@/components/ui/delta";
import { describeCommentDelta } from "@/lib/format";
import { TimeAgo } from "@/components/ui/time-ago";
import { formatCompact, formatDate, formatNumber, formatPct, truncate } from "@/lib/format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tabular text-sm font-medium">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-strong">{label}</div>
    </div>
  );
}

function CommentDelta({ value }: { value: number | null }) {
  const d = describeCommentDelta(value);
  return (
    <span
      className={
        d.tone === "positive"
          ? "tabular text-[11px] font-medium text-positive"
          : "text-[11px] text-muted-strong"
      }
      title={d.tooltip ?? undefined}
    >
      {d.text}
    </span>
  );
}

export function PlatformCard({ stats }: { stats: PlatformStats }) {
  const bestTitle = stats.bestVideo
    ? (stats.bestVideo.video.title ?? stats.bestVideo.video.caption ?? "Untitled video")
    : null;
  return (
    <Card className="flex flex-col gap-3.5 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PlatformBadge platform={stats.platform} />
        <StatusPill status={stats.sourceStatus} size="sm" />
      </div>

      <div>
        <div className="tabular text-3xl font-semibold tracking-tight">
          {formatCompact(stats.views)}
        </div>
        <div className="text-[10px] uppercase tracking-wide text-muted-strong">Views</div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Stat label="Likes" value={formatCompact(stats.likes)} />
        <Stat label="Comments" value={formatCompact(stats.comments)} />
        <Stat label="Eng. rate" value={formatPct(stats.engagementRate)} />
        <Stat label="Videos" value={formatNumber(stats.videoCount)} />
        <Stat label="Avg views/video" value={formatCompact(stats.avgViewsPerVideo)} />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-3">
        <DeltaTag value={stats.viewsGained24h} label="views 24h" />
        <CommentDelta value={stats.commentsGained24h} />
      </div>

      <dl className="mt-auto space-y-1.5 border-t border-border pt-3 text-[11px]">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="shrink-0 text-muted-strong">Best video</dt>
          <dd className="min-w-0 text-right">
            {stats.bestVideo && bestTitle ? (
              <a
                href={stats.bestVideo.video.originalUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={bestTitle}
                className="block truncate text-foreground transition-colors hover:text-accent"
              >
                {truncate(bestTitle, 36)}
              </a>
            ) : (
              <span className="text-muted-strong">—</span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-strong">Latest post</dt>
          <dd className="text-muted">
            {stats.latestVideo
              ? formatDate(stats.latestVideo.publishedAt ?? stats.latestVideo.firstTrackedAt)
              : "—"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted-strong">Last refresh</dt>
          <dd className="text-muted">
            <TimeAgo iso={stats.lastSuccessfulRefreshAt} />
          </dd>
        </div>
      </dl>
    </Card>
  );
}
