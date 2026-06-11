// PATCH /api/admin/campaign { startDate } → updates the campaign start date
// and records a ManualOverride.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { ensureSeedData } from "@/lib/seed";
import {
  asIsoDate,
  asTrimmedString,
  badRequest,
  guardAdmin,
  readJsonObject,
  serverError,
} from "../_utils";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  try {
    const body = await readJsonObject(req);
    if (!body) return badRequest("Request body must be a JSON object");
    if (!("startDate" in body)) return badRequest("startDate is required");

    let startDate: string | null = null;
    if (body.startDate !== null && body.startDate !== "") {
      startDate = asIsoDate(body.startDate);
      if (!startDate) return badRequest("startDate must be a valid date");
    }

    const store = getStore();
    const campaign = await ensureSeedData(store);

    if (startDate === campaign.startDate) {
      return NextResponse.json({ ok: true, campaign });
    }

    const updated = await store.updateCampaign(campaign.id, { startDate });
    await store.addOverride({
      entityType: "campaign",
      entityId: campaign.id,
      field: "startDate",
      oldValue: campaign.startDate,
      newValue: startDate,
      reason: asTrimmedString(body.reason),
    });

    return NextResponse.json({ ok: true, campaign: updated });
  } catch (e) {
    return serverError(e, "Failed to update campaign");
  }
}
