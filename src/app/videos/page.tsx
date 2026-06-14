// Videos — the content performance command center for individual campaign
// posts. Server component fetches range-aware rows once (period growth +
// sparklines + audience signals); the explorer handles all interactivity.
// Read-only: no mutation controls ever render here.

import { PageHeader } from "@/components/layout/page-header";
import { AutoRefreshNote } from "@/components/ui/auto-refresh-note";
import { RangeSwitcher } from "@/components/dashboard/range-switcher";
import { TimeAgo } from "@/components/ui/time-ago";
import { getVideosPageData, type TimeRange } from "@/lib/queries";
import { VideosExplorer } from "./videos-explorer";

export const dynamic = "force-dynamic";

function parseRange(value: string | string[] | undefined): TimeRange {
  return value === "24h" || value === "7d" || value === "30d" || value === "all" ? value : "7d";
}

export default async function VideosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const { rows, episodes, range: active, rangeLabel, platformCount, lastUpdatedAt, historyStart } =
    await getVideosPageData(range);

  const trackedCount = rows.filter((r) => !r.video.hidden).length;
  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span>Tracked campaign content across every platform</span>
      <span aria-hidden className="text-muted-strong">·</span>
      <span>
        {trackedCount} video{trackedCount === 1 ? "" : "s"} · {platformCount} live platform
        {platformCount === 1 ? "" : "s"}
      </span>
      <span aria-hidden className="text-muted-strong">·</span>
      <span>
        {lastUpdatedAt ? (
          <>
            updated <TimeAgo iso={lastUpdatedAt} />
          </>
        ) : (
          "awaiting first refresh"
        )}
      </span>
    </span>
  );

  return (
    <div>
      <PageHeader
        title="Videos"
        subtitle={subtitle}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <RangeSwitcher active={active} basePath="/videos" />
            <AutoRefreshNote />
          </div>
        }
      />
      <VideosExplorer
        rows={rows}
        rangeLabel={rangeLabel}
        episodes={episodes.map((e) => ({ id: e.id, name: e.name }))}
      />
      {historyStart && trackedCount > 0 && (
        <p className="mt-4 px-1 text-[11px] text-muted-strong">
          Selected-range growth and sparklines are computed from real snapshots only · tracking
          since <TimeAgo iso={historyStart} />. Lifetime totals are independent of the selected
          range.
        </p>
      )}
    </div>
  );
}
