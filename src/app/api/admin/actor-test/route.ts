// POST /api/admin/actor-test { platform, actorId, testUrl?, inputOverride? }
// Runs the actor against the platform's seed URL and returns the inspection
// result. Long-running: actor runs can take a couple of minutes.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { testActor } from "@/lib/apify/actor-test";
import { asTrimmedString, badRequest, guardAdmin, isPlatform, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const body = await readJsonObject(req);
  if (!body) return badRequest("Invalid JSON body");
  if (!isPlatform(body.platform)) return badRequest("Unknown platform");
  const actorId = asTrimmedString(body.actorId);
  if (!actorId) return badRequest("actorId is required");

  let inputOverride: unknown = undefined;
  if (typeof body.inputOverride === "string" && body.inputOverride.trim()) {
    try {
      inputOverride = JSON.parse(body.inputOverride);
    } catch {
      return badRequest("inputOverride is not valid JSON");
    }
  } else if (body.inputOverride && typeof body.inputOverride === "object") {
    inputOverride = body.inputOverride;
  }

  try {
    const result = await testActor({
      platform: body.platform,
      actorId,
      testUrl: asTrimmedString(body.testUrl) ?? undefined,
      inputOverride,
      store: getStore(),
      // dryRun (e.g. testing a BACKUP actor) must not overwrite the primary
      // provider config.
      save: body.dryRun !== true,
    });
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    return serverError(e, "Actor test failed");
  }
}
