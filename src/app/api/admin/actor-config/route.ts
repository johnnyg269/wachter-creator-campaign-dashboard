// POST /api/admin/actor-config { platform, actorId, inputOverride? }
// Saves the Apify actor assignment for a platform. Actor IDs are not secrets,
// but the route is still admin-guarded; tokens never pass through here.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { asTrimmedString, badRequest, guardAdmin, isPlatform, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const body = await readJsonObject(req);
  if (!body) return badRequest("Invalid JSON body");
  if (!isPlatform(body.platform)) return badRequest("Unknown platform");
  const backupActorId = asTrimmedString(body.backupActorId);
  const clearBackup = body.backupActorId === null || body.backupActorId === "";
  const actorId = asTrimmedString(body.actorId);
  // Backup-only updates are allowed (primary stays as-is).
  if (!actorId && !backupActorId && !clearBackup) return badRequest("actorId is required");
  if (actorId && !/^[\w~/.-]+$/.test(actorId)) return badRequest("actorId has an unexpected format");
  if (backupActorId && !/^[\w~/.-]+$/.test(backupActorId)) {
    return badRequest("backupActorId has an unexpected format");
  }

  let inputOverride: unknown = undefined;
  if (body.inputOverride !== undefined && body.inputOverride !== null && body.inputOverride !== "") {
    if (typeof body.inputOverride === "string") {
      try {
        inputOverride = JSON.parse(body.inputOverride);
      } catch {
        return badRequest("inputOverride is not valid JSON");
      }
    } else if (typeof body.inputOverride === "object") {
      inputOverride = body.inputOverride;
    }
  }

  try {
    const store = getStore();
    const existing = await store.getProviderConfig(body.platform);
    const effectiveActorId = actorId ?? existing?.actorId ?? null;
    const actorChanged = actorId !== null && existing?.actorId !== actorId;
    const config = await store.upsertProviderConfig({
      platform: body.platform,
      providerType: "apify",
      actorId: effectiveActorId,
      backupActorId: clearBackup ? null : (backupActorId ?? existing?.backupActorId ?? null),
      // A new actor must be re-tested before we trust prior capability flags.
      status: actorChanged ? "untested" : (existing?.status ?? "untested"),
      lastTestedAt: actorChanged ? null : (existing?.lastTestedAt ?? null),
      lastTestResult: actorChanged ? null : (existing?.lastTestResult ?? null),
      detectedFields: actorChanged ? [] : (existing?.detectedFields ?? []),
      supportsMetadata: actorChanged ? false : (existing?.supportsMetadata ?? false),
      supportsMetrics: actorChanged ? false : (existing?.supportsMetrics ?? false),
      supportsComments: actorChanged ? false : (existing?.supportsComments ?? false),
      supportsDiscovery: actorChanged ? false : (existing?.supportsDiscovery ?? false),
      inputOverride: inputOverride !== undefined ? inputOverride : (existing?.inputOverride ?? null),
      lastSuccessfulRefreshAt: existing?.lastSuccessfulRefreshAt ?? null,
    });
    return NextResponse.json({ ok: true, config });
  } catch (e) {
    return serverError(e, "Failed to save actor config");
  }
}
