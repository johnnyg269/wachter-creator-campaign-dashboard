// Alerts — open + reviewed alert queue with severity/platform/type filters.

import { getAlertsPageData } from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import { RefreshButton } from "@/components/ui/refresh-button";
import { AlertsBoard } from "./alerts-board";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const { open, reviewed } = await getAlertsPageData();
  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={`${open.length} open · ${reviewed.length} reviewed`}
        actions={<RefreshButton />}
      />
      <AlertsBoard open={open} reviewed={reviewed} />
    </>
  );
}
