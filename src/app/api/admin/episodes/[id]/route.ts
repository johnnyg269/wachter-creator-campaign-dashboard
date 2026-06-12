// PATCH  /api/admin/episodes/[id] { name?, description? } → rename or
//        re-describe. Assigned videos keep their assignment (id is stable)
//        and historical rollups follow the renamed episode automatically.
// DELETE /api/admin/episodes/[id] { replacementId? } → delete the episode,
//        first moving its videos to replacementId (or Unassigned when
//        null/omitted). Videos themselves are NEVER deleted.
// Admin-only; every change lands in the override audit log.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import {
  asTrimmedString,
  badRequest,
  guardAdmin,
  notFound,
  readJsonObject,
  serverError,
} from "../../_utils";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJsonObject(req);
    if (!body) return badRequest("Request body must be a JSON object");

    const store = getStore();
    const episodes = await store.listEpisodeGroups();
    const current = episodes.find((e) => e.id === id);
    if (!current) return notFound("Episode not found");

    const patch: { name?: string; description?: string | null } = {};
    if ("name" in body) {
      const name = asTrimmedString(body.name);
      if (!name) return badRequest("Episode name cannot be empty");
      if (name.length > 80) return badRequest("Episode name must be 80 characters or fewer");
      if (episodes.some((e) => e.id !== id && e.name.toLowerCase() === name.toLowerCase())) {
        return badRequest("An episode with that name already exists");
      }
      patch.name = name;
    }
    if ("description" in body) {
      patch.description = asTrimmedString(body.description);
    }
    if (Object.keys(patch).length === 0) return badRequest("Nothing to update");

    const episode = await store.updateEpisodeGroup(id, patch);
    if (patch.name !== undefined && patch.name !== current.name) {
      await store.addOverride({
        entityType: "episode",
        entityId: id,
        field: "name",
        oldValue: current.name,
        newValue: patch.name,
        reason: null,
      });
    }
    return NextResponse.json({ ok: true, episode });
  } catch (e) {
    return serverError(e, "Failed to update episode");
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  try {
    const { id } = await params;
    // Body is optional for DELETE; default is "move members to Unassigned".
    const body = (await readJsonObject(req)) ?? {};
    const replacementRaw = body.replacementId;
    const replacementId =
      typeof replacementRaw === "string" && replacementRaw.length > 0 ? replacementRaw : null;
    if (replacementId === id) {
      return badRequest("Replacement cannot be the episode being deleted");
    }

    const store = getStore();
    const episodes = await store.listEpisodeGroups();
    const current = episodes.find((e) => e.id === id);
    if (!current) return notFound("Episode not found");
    if (replacementId !== null && !episodes.some((e) => e.id === replacementId)) {
      return notFound("Replacement episode not found");
    }

    const { videosMoved } = await store.deleteEpisodeGroup(id, replacementId);
    await store.addOverride({
      entityType: "episode",
      entityId: id,
      field: "deleted",
      oldValue: current.name,
      newValue: replacementId
        ? `${videosMoved} videos → ${episodes.find((e) => e.id === replacementId)?.name ?? replacementId}`
        : `${videosMoved} videos → Unassigned`,
      reason: null,
    });
    return NextResponse.json({ ok: true, videosMoved });
  } catch (e) {
    return serverError(e, "Failed to delete episode");
  }
}
