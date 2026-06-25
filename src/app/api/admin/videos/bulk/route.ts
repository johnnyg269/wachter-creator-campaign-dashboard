// POST /api/admin/videos/bulk { ids: string[], action, campaign?, reason? }
// Admin-only bulk campaign assignment + remove/restore tracking. Schema-free
// (rawJson), one ManualOverride row per changed video. Never hard-deletes.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import type { Video } from "@/lib/types";
import {
  campaignAssignmentPatch,
  trackingPatch,
  videoCampaign,
  isAdminExcluded,
} from "@/lib/campaigns";
import { badRequest, guardAdmin, readJsonObject, serverError } from "../../_utils";

export const dynamic = "force-dynamic";

type BulkAction = "assign" | "exclude" | "restore";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  try {
    const body = await readJsonObject(req);
    if (!body) return badRequest("Request body must be a JSON object");

    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length === 0) return badRequest("ids must be a non-empty string array");
    if (ids.length > 500) return badRequest("Too many ids (max 500)");

    const action = body.action as BulkAction;
    if (action !== "assign" && action !== "exclude" && action !== "restore") {
      return badRequest('action must be "assign", "exclude", or "restore"');
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    let campaign: "mtl" | "bootcamp" | "unassigned" | null = null;
    if (action === "assign") {
      const c = body.campaign;
      if (c !== "mtl" && c !== "bootcamp" && c !== "unassigned") {
        return badRequest('assign requires campaign "mtl" | "bootcamp" | "unassigned"');
      }
      campaign = c;
    }
    if (action === "exclude" && !reason) {
      return badRequest("A reason is required to remove videos from tracking");
    }

    const store = getStore();
    const now = new Date().toISOString();
    let updated = 0;
    const missing: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];

    for (const id of ids) {
      try {
        const video = await store.getVideo(id);
        if (!video) {
          missing.push(id);
          continue;
        }
        const patch: Partial<Video> = {};
        let field: string, oldValue: string, newValue: string;
        if (action === "assign" && campaign) {
          patch.rawJson = campaignAssignmentPatch(video.rawJson, campaign) as Video["rawJson"];
          field = "campaign";
          oldValue = videoCampaign(video) ?? "unassigned";
          newValue = campaign;
        } else {
          const a = action as "exclude" | "restore";
          const wasExcluded = isAdminExcluded(video);
          patch.rawJson = trackingPatch(video.rawJson, a, { reason: reason ?? undefined, now }) as Video["rawJson"];
          // Exclude → hide. Restore → un-hide ONLY a video WE excluded, so we
          // never accidentally surface a separately-hidden (review/quarantine) one.
          if (a === "exclude") patch.hidden = true;
          else if (wasExcluded) patch.hidden = false;
          field = "tracking";
          oldValue = wasExcluded ? "excluded" : "active";
          newValue = a === "exclude" ? "excluded" : "active";
        }
        await store.updateVideo(id, patch);
        await store.addOverride({ entityType: "video", entityId: id, field, oldValue, newValue, reason });
        updated++;
      } catch (e) {
        // One bad id never aborts the batch — record it and continue.
        failed.push({ id, error: e instanceof Error ? e.message.slice(0, 120) : "update failed" });
      }
    }

    return NextResponse.json({ ok: true, updated, missing, failed });
  } catch (e) {
    return serverError(e, "Bulk update failed");
  }
}
