// Platform leaderboard — Phase 3.7 replacement for the four-identical-cards
// grid on the homepage. Ranked rows with an animated share-of-views bar so
// "who is winning" reads in one glance. The detailed per-platform cards
// still live on /platforms.

import clsx from "clsx";
import type { PlatformStats } from "@/lib/queries";
import { PLATFORM_LABELS, type Platform } from "@/lib/types";
import { PlatformBadge } from "@/components/ui/platform";
import { DeltaTag } from "@/components/ui/delta";
import { formatCompact, formatNumber, formatPct, truncate } from "@/lib/format";

const PLATFORM_HEX: Record<Platform, string> = {
  tiktok: "#25f4ee",
  youtube: "#ff4444",
  instagram: "#e95daa",
  facebook: "#4b8dff",
};

export function PlatformLeaderboard({ stats }: { stats: PlatformStats[] }) {
  const ranked = [...stats].sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  const totalViews = ranked.reduce((a, s) => a + (s.views ?? 0), 0);

  return (
    <div className="divide-y divide-border">
      {ranked.map((s, i) => {
        const share =
          totalViews > 0 && s.views !== null ? Math.round((s.views / totalViews) * 100) : null;
        const bestTitle = s.bestVideo
          ? (s.bestVideo.video.title ?? s.bestVideo.video.caption ?? "Untitled video")
          : null;
        const leader = i === 0 && (s.views ?? 0) > 0;
        return (
          <div
            key={s.platform}
            className={clsx(
              "grid grid-cols-[auto_minmax(120px,1fr)_minmax(0,2fr)] items-center gap-x-4 gap-y-2 px-1 py-3.5",
              "max-md:grid-cols-[auto_1fr]",
            )}
          >
            {/* Rank */}
            <span
              className={clsx(
                "flex h-6 w-6 items-center justify-center rounded-lg text-xs font-bold tabular-nums",
                leader
                  ? "bg-[var(--accent-soft)] text-accent ring-1 ring-accent/30"
                  : "border border-border text-muted-strong",
              )}
              title={leader ? "Leading platform by views" : `#${i + 1} by views`}
            >
              {i + 1}
            </span>

            {/* Platform + views */}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <PlatformBadge platform={s.platform} size="sm" />
                {leader && (
                  <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">
                    Leader
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="tabular-nums text-xl font-bold tracking-tight">
                  {formatCompact(s.views)}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-muted-strong">views</span>
                <DeltaTag value={s.viewsGained24h} label="24h" />
              </div>
            </div>

            {/* Share bar + supporting stats */}
            <div className="min-w-0 max-md:col-span-2">
              <div
                className="h-1.5 overflow-hidden rounded-full bg-surface-hover"
                title={share !== null ? `${share}% of all campaign views` : undefined}
              >
                {share !== null && (
                  <div
                    className="bar-fill h-full rounded-full"
                    style={{
                      width: `${Math.max(2, share)}%`,
                      background: PLATFORM_HEX[s.platform],
                      opacity: 0.9,
                    }}
                  />
                )}
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
                <span className="tabular-nums font-medium text-foreground/90">
                  {share !== null ? `${share}% of views` : "Share —"}
                </span>
                <span className="tabular-nums">
                  {s.engagementRate !== null ? `${formatPct(s.engagementRate)} ER` : "ER —"}
                </span>
                <span className="tabular-nums">
                  {formatNumber(s.videoCount)} {s.videoCount === 1 ? "video" : "videos"}
                </span>
                {s.bestVideo && bestTitle && (
                  <a
                    href={s.bestVideo.video.originalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={bestTitle}
                    className="min-w-0 truncate text-muted transition-colors hover:text-accent"
                  >
                    Best: “{truncate(bestTitle, 44)}”
                  </a>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <p className="px-1 pt-2.5 text-[10px] text-muted-strong">
        Ranked by confirmed views · {PLATFORM_LABELS[ranked[0]?.platform ?? "tiktok"]} leads ·
        full platform detail on the Platforms page
      </p>
    </div>
  );
}
