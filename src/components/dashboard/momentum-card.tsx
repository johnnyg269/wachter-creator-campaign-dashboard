// Momentum card: short-window view velocity plus "what's hot right now".
// Null windows mean "not enough snapshots", never zero.

import clsx from "clsx";
import type { MomentumData } from "@/lib/queries";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PlatformBadge, PlatformDot } from "@/components/ui/platform";
import { DeltaTag } from "@/components/ui/delta";
import { TimeAgo } from "@/components/ui/time-ago";
import { formatDelta, truncate } from "@/lib/format";
import type { Video } from "@/lib/types";

function WindowStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-strong">{label}</div>
      {value === null ? (
        <>
          <div className="tabular mt-0.5 text-xl font-semibold text-muted-strong">—</div>
          <div className="text-[10px] text-muted-strong">Needs two snapshots</div>
        </>
      ) : (
        <>
          <div
            className={clsx(
              "tabular mt-0.5 text-xl font-semibold",
              value > 0 ? "text-positive" : value < 0 ? "text-negative" : "text-muted",
            )}
          >
            {formatDelta(value)}
          </div>
          <div className="text-[10px] text-muted-strong">views</div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="shrink-0 text-xs text-muted-strong">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-2 text-right">{children}</span>
    </div>
  );
}

function VideoLink({ video }: { video: Video }) {
  const title = video.title ?? video.caption ?? "Untitled video";
  return (
    <a
      href={video.originalUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      className="flex min-w-0 items-center gap-1.5 text-xs font-medium transition-colors hover:text-accent"
    >
      <PlatformDot platform={video.platform} />
      <span className="truncate">{truncate(title, 42)}</span>
    </a>
  );
}

function formatVelocity(cph: number): string {
  return `≈${cph >= 1 ? Math.round(cph).toLocaleString("en-US") : cph.toFixed(1)}/hr`;
}

export function MomentumCard({ momentum }: { momentum: MomentumData }) {
  return (
    <Card>
      <CardHeader title="Momentum" subtitle="View velocity across all tracked videos" />
      <CardBody>
        <div className="grid grid-cols-3 gap-2.5">
          <WindowStat label="Last 10 min" value={momentum.views10m} />
          <WindowStat label="Last hour" value={momentum.views1h} />
          <WindowStat label="Last 24h" value={momentum.views24h} />
        </div>

        <div className="mt-3 divide-y divide-border">
          <Row label="Best platform today">
            {momentum.bestPlatformToday ? (
              <>
                <PlatformBadge platform={momentum.bestPlatformToday.platform} size="sm" />
                <DeltaTag value={momentum.bestPlatformToday.gained} label="views" />
              </>
            ) : (
              <span className="text-xs text-muted-strong" title="Needs two snapshots">
                —
              </span>
            )}
          </Row>

          <Row label="Newest video">
            {momentum.newestVideo ? (
              <>
                <VideoLink video={momentum.newestVideo} />
                <span className="shrink-0 text-[11px] text-muted-strong">
                  <TimeAgo
                    iso={momentum.newestVideo.publishedAt ?? momentum.newestVideo.firstTrackedAt}
                  />
                </span>
              </>
            ) : (
              <span className="text-xs text-muted-strong">No videos tracked yet</span>
            )}
          </Row>

          <Row label="Fastest-growing video">
            {momentum.fastestGrowing ? (
              <>
                <VideoLink video={momentum.fastestGrowing.video} />
                <DeltaTag value={momentum.fastestGrowing.gained24h} label="24h" />
              </>
            ) : (
              <span className="text-xs text-muted-strong" title="Needs two snapshots">
                —
              </span>
            )}
          </Row>

          <Row label="Comment velocity">
            {momentum.commentsPerHour !== null ? (
              <span className="tabular text-sm font-semibold">
                {formatVelocity(momentum.commentsPerHour)}
              </span>
            ) : (
              <span className="text-xs text-muted-strong" title="No comments in the last 24h">
                —
              </span>
            )}
          </Row>
        </div>
      </CardBody>
    </Card>
  );
}
