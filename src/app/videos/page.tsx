// Video library — every tracked video across all four platforms, with
// client-side filtering, search, and sorting. Server component fetches once;
// the table handles all interactivity.

import { PageHeader } from "@/components/layout/page-header";
import { RefreshButton } from "@/components/ui/refresh-button";
import { getVideosPageData } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { VideosTable } from "./videos-table";

export const dynamic = "force-dynamic";

export default async function VideosPage() {
  const { campaign, episodes, rows } = await getVideosPageData();
  const trackedCount = rows.filter((r) => !r.video.hidden).length;
  const countLabel = `${trackedCount} video${trackedCount === 1 ? "" : "s"} tracked`;

  return (
    <div>
      <PageHeader
        title="Video library"
        subtitle={
          campaign.startDate
            ? `${countLabel} · campaign started ${formatDate(campaign.startDate)}`
            : countLabel
        }
        actions={<RefreshButton />}
      />
      <VideosTable rows={rows} episodes={episodes} />
    </div>
  );
}
