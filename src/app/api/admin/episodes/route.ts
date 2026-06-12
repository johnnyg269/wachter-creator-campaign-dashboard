// POST /api/admin/episodes { name, description? } → create an episode /
// content concept. Admin-only; every creation lands in the override audit log.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { asTrimmedString, badRequest, guardAdmin, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  try {
    const body = await readJsonObject(req);
    if (!body) return badRequest("Request body must be a JSON object");
    const name = asTrimmedString(body.name);
    if (!name) return badRequest("Episode name is required");
    if (name.length > 80) return badRequest("Episode name must be 80 characters or fewer");
    const description = asTrimmedString(body.description);

    const store = getStore();
    const campaign = await store.getCampaign();
    if (!campaign) return badRequest("No campaign configured yet");

    const existing = await store.listEpisodeGroups();
    if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
      return badRequest("An episode with that name already exists");
    }

    const episode = await store.upsertEpisodeGroupByName({
      campaignId: campaign.id,
      name,
      description,
    });
    await store.addOverride({
      entityType: "episode",
      entityId: episode.id,
      field: "created",
      oldValue: null,
      newValue: name,
      reason: null,
    });
    return NextResponse.json({ ok: true, episode });
  } catch (e) {
    return serverError(e, "Failed to create episode");
  }
}
