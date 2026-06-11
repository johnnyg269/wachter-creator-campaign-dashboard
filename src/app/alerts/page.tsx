// Alerts — open + reviewed alert queue with severity/platform/type filters.

import { getAlertsPageData } from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import { AutoRefreshNote } from "@/components/ui/auto-refresh-note";
import { AlertsBoard } from "./alerts-board";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const { open, reviewed } = await getAlertsPageData();
  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={`${open.length} open · ${reviewed.length} reviewed`}
        actions={<AutoRefreshNote />}
      />
      <AlertsBoard open={open} reviewed={reviewed} />
    </>
  );
}
