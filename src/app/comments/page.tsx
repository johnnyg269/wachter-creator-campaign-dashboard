// Unified comment feed across all four platforms. Server component loads the
// full comment set once; filtering/sorting/pagination happen client-side in
// CommentFeed (the dataset is capped at 1000 by the query layer).

import type { Metadata } from "next";
import { getCommentsPageData, getHealth } from "@/lib/queries";
import { parsePublicCampaignFilter } from "@/lib/campaigns";
import { CampaignSwitcher } from "@/components/dashboard/campaign-switcher";
import { formatNumber } from "@/lib/format";
import { PageHeader } from "@/components/layout/page-header";
import { DataNotice } from "@/components/layout/data-notice";
import { AutoRefreshNote } from "@/components/ui/auto-refresh-note";
import { CommentFeed } from "./comment-feed";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Comments — Wachter Creator Campaign Dashboard",
};

export default async function CommentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const campaignFilter = parsePublicCampaignFilter((await searchParams).campaign);
  const [data, health] = await Promise.all([getCommentsPageData(campaignFilter), getHealth()]);
  const count = data.comments.length;

  return (
    <div>
      <DataNotice health={health} />
      <PageHeader
        title="Comments"
        subtitle={`${formatNumber(count)} ${count === 1 ? "comment" : "comments"} across 4 platforms`}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <CampaignSwitcher active={campaignFilter} basePath="/comments" />
            <AutoRefreshNote />
          </div>
        }
      />
      <CommentFeed
        comments={data.comments}
        videos={data.videos}
        episodes={data.episodes}
      />
    </div>
  );
}
