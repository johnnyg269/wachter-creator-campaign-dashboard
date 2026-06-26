// GET /api/admin/reconcile — read-only campaign reconciliation. Returns the live
// active/public totals (mirrored from the dashboard's own loadCampaignData) plus
// a raw-record breakdown explaining any total-vs-active gap. Admin session OR
// CRON_SECRET bearer (shared fail-closed guard). No writes, no provider calls,
// no Apify — pure reporting.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { reconcileCampaigns } from "@/lib/reconcile";
import { isAdminOrCronBearer, serverError } from "../_utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const report = await reconcileCampaigns(getStore(), new Date());
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return serverError(e, "Reconciliation failed");
  }
}
