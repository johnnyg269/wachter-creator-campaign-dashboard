// Featured #1 video — the winning post gets a real spotlight above the
// ranked list instead of being row one of eight.

import { ExternalLink, Trophy } from "lucide-react";
import type { VideoMetrics } from "@/lib/metrics";
import { VideoThumb } from "@/components/ui/video-thumb";
import { PlatformBadge } from "@/components/ui/platform";
import { DeltaTag } from "@/components/ui/delta";
import { MetricValue } from "@/components/ui/metric-value";
import { formatDate, formatPct, truncate } from "@/lib/format";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="tabular-nums text-lg font-bold leading-tight tracking-tight">{children}</div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-muted-strong">{label}</div>
    </div>
  );
}

export function FeaturedVideo({ m }: { m: VideoMetrics }) {
  const title = m.video.title ?? m.video.caption ?? "Untitled video";
  return (
    <div className="relative mb-4 flex flex-wrap items-center gap-4 overflow-hidden rounded-xl border border-accent/25 bg-[radial-gradient(ellipse_70%_120%_at_8%_50%,rgba(59,130,246,0.1),transparent_60%)] p-4">
      <VideoThumb
        src={m.video.thumbnailUrl}
        platform={m.video.platform}
        alt={title}
        className="h-20 w-14 shrink-0 rounded-lg"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-accent">
          <Trophy size={11} aria-hidden />
          Top performing post
        </div>
        <a
          href={m.video.originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className="mt-1 block truncate text-base font-semibold tracking-tight transition-colors hover:text-accent"
        >
          {truncate(title, 90)}
        </a>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-strong">
          <PlatformBadge platform={m.video.platform} size="sm" />
          <span>{m.video.publishedAt ? formatDate(m.video.publishedAt) : "Publish date unknown"}</span>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2">
        <Stat label="Views">
          <MetricValue confirmed={m.confirmed.views} hasAnySnapshot={m.latest !== null} />
        </Stat>
        <Stat label="Likes">
          <MetricValue confirmed={m.confirmed.likes} hasAnySnapshot={m.latest !== null} />
        </Stat>
        <Stat label="Eng. rate">{formatPct(m.engagementRate)}</Stat>
        <div>
          <DeltaTag value={m.delta24h?.value ?? null} label="views 24h" />
        </div>
        <a
          href={m.video.originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open "${truncate(title, 60)}"`}
          className="rounded-lg border border-border bg-surface p-2 text-muted transition-colors hover:border-border-strong hover:text-foreground"
        >
          <ExternalLink size={14} />
        </a>
      </div>
    </div>
  );
}
