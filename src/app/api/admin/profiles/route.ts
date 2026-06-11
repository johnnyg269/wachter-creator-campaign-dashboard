// POST /api/admin/profiles { url } → parse and upsert a creator profile used
// for discovery on its platform.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { ensureSeedData } from "@/lib/seed";
import { resolveProvider } from "@/lib/providers/registry";
import { parseProfileUrl } from "@/lib/url-parse";
import {
  asTrimmedString,
  badRequest,
  guardAdmin,
  readJsonObject,
  serverError,
} from "../_utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  try {
    const body = await readJsonObject(req);
    if (!body) return badRequest("Request body must be a JSON object");

    const url = asTrimmedString(body.url);
    if (!url) return badRequest("A profile URL is required");

    const parsed = parseProfileUrl(url);
    if (!parsed) {
      return badRequest(
        "Unrecognized URL — paste a TikTok, YouTube, Instagram, or Facebook profile link",
      );
    }

    const store = getStore();
    const campaign = await ensureSeedData(store);
    const { readiness } = await resolveProvider(parsed.platform, store);

    const profile = await store.upsertProfileByUrl({
      campaignId: campaign.id,
      platform: parsed.platform,
      profileUrl: url,
      handle: parsed.handle,
      externalProfileId: parsed.externalProfileId,
      lastDiscoveredAt: null,
      status: readiness.ready ? "waiting" : readiness.sourceStatus,
    });

    return NextResponse.json({ ok: true, profile });
  } catch (e) {
    return serverError(e, "Failed to add profile");
  }
}
