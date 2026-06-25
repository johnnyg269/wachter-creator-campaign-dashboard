// PATCH /api/admin/videos/[id] { title?, thumbnailUrl?, episodeGroupId?,
// hidden?, status?, reason? } → updates the video and records one
// ManualOverride row per changed field.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import type { Video, VideoStatus } from "@/lib/types";
import { isReviewCandidate } from "@/lib/eligibility";
import { mergeThumbIntoRaw } from "@/lib/thumbnail-state";
import {
  campaignAssignmentPatch,
  isAdminExcluded,
  trackingPatch,
  videoCampaign,
} from "@/lib/campaigns";
import {
  asTrimmedString,
  badRequest,
  guardAdmin,
  notFound,
  readJsonObject,
  serverError,
} from "../../_utils";

export const dynamic = "force-dynamic";

const VIDEO_STATUSES: VideoStatus[] = ["active", "unavailable", "failed_fetch", "needs_auth"];

interface Change {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

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
    const video = await store.getVideo(id);
    if (!video) return notFound("Video not found");

    const reason = asTrimmedString(body.reason);
    const patch: Partial<Video> = {};
    const changes: Change[] = [];

    // Nullable string fields: explicit null clears, string sets.
    const stringField = (field: "title" | "thumbnailUrl"): NextResponse | null => {
      if (!(field in body)) return null;
      const raw = body[field];
      if (raw !== null && typeof raw !== "string") {
        return badRequest(`${field} must be a string or null`);
      }
      const next = raw === null ? null : (raw.trim() ? raw.trim() : null);
      if (next !== video[field]) {
        patch[field] = next;
        changes.push({ field, oldValue: video[field], newValue: next });
      }
      return null;
    };
    const titleErr = stringField("title");
    if (titleErr) return titleErr;
    const thumbErr = stringField("thumbnailUrl");
    if (thumbErr) return thumbErr;

    if ("episodeGroupId" in body) {
      const raw = body.episodeGroupId;
      if (raw !== null && typeof raw !== "string") {
        return badRequest("episodeGroupId must be a string or null");
      }
      const next = raw === null || !raw.trim() ? null : raw.trim();
      if (next) {
        const episodes = await store.listEpisodeGroups();
        if (!episodes.some((e) => e.id === next)) return badRequest("Unknown episode group");
      }
      if (next !== video.episodeGroupId) {
        patch.episodeGroupId = next;
        changes.push({ field: "episodeGroupId", oldValue: video.episodeGroupId, newValue: next });
      }
    }

    if ("hidden" in body) {
      if (typeof body.hidden !== "boolean") return badRequest("hidden must be a boolean");
      if (body.hidden !== video.hidden) {
        patch.hidden = body.hidden;
        changes.push({
          field: "hidden",
          oldValue: String(video.hidden),
          newValue: String(body.hidden),
        });
      }
    }

    // Discovery review queue: promote a "Possible new content" candidate into the
    // campaign (un-hide + clear the review flag so it counts) or dismiss it
    // (keep hidden, clear the flag so it leaves the queue). Quarantine via hidden
    // above still applies independently.
    if ("review" in body && isReviewCandidate(video)) {
      const action = body.review;
      if (action !== "promote" && action !== "dismiss") {
        return badRequest('review must be "promote" or "dismiss"');
      }
      const rawObj =
        video.rawJson && typeof video.rawJson === "object"
          ? { ...(video.rawJson as Record<string, unknown>) }
          : {};
      delete rawObj.discoveryReview;
      delete rawObj.discoveryReviewReason;
      patch.rawJson = rawObj as Video["rawJson"];
      patch.hidden = action === "promote" ? false : true;
      changes.push({
        field: "discovery_review",
        oldValue: "pending",
        newValue: action === "promote" ? "added_to_campaign" : "dismissed",
      });
    }

    if ("status" in body) {
      const status = body.status;
      if (typeof status !== "string" || !(VIDEO_STATUSES as string[]).includes(status)) {
        return badRequest(`status must be one of: ${VIDEO_STATUSES.join(", ")}`);
      }
      if (status !== video.status) {
        patch.status = status as VideoStatus;
        changes.push({ field: "status", oldValue: video.status, newValue: status });
      }
    }

    // Campaign assignment (schema-free: rawJson.campaign). "unassigned" keeps the
    // video tracked but out of public All/MTL/Bootcamp scopes (still in admin).
    if ("campaign" in body) {
      const c = body.campaign;
      if (c !== "mtl" && c !== "bootcamp" && c !== "unassigned") {
        return badRequest('campaign must be "mtl", "bootcamp", or "unassigned"');
      }
      const base = patch.rawJson !== undefined ? patch.rawJson : video.rawJson;
      patch.rawJson = campaignAssignmentPatch(base, c) as Video["rawJson"];
      changes.push({ field: "campaign", oldValue: videoCampaign(video) ?? "unassigned", newValue: c });
    }

    // Remove-from-tracking / restore (SOFT delete — never touches snapshots or
    // metric history). Excluded → hidden, so it leaves every public total/grid/
    // chart/refresh; recoverable from the admin Excluded view.
    if ("tracking" in body) {
      const action = body.tracking;
      if (action !== "exclude" && action !== "restore") {
        return badRequest('tracking must be "exclude" or "restore"');
      }
      if (action === "exclude" && !reason) {
        return badRequest("A reason is required to remove a video from tracking");
      }
      const base = patch.rawJson !== undefined ? patch.rawJson : video.rawJson;
      const wasExcluded = isAdminExcluded(video);
      patch.rawJson = trackingPatch(base, action, {
        reason: reason ?? undefined,
        now: new Date().toISOString(),
      }) as Video["rawJson"];
      // Exclude → hide. Restore → un-hide ONLY a video WE excluded (never
      // surface a separately review/quarantine-hidden one). Tracking takes
      // precedence over any standalone `hidden` change in the same request.
      if (action === "exclude") patch.hidden = true;
      else if (wasExcluded) patch.hidden = false;
      const hiddenChangeIdx = changes.findIndex((c) => c.field === "hidden");
      if (hiddenChangeIdx !== -1) changes.splice(hiddenChangeIdx, 1);
      changes.push({
        field: "tracking",
        oldValue: wasExcluded ? "excluded" : "active",
        newValue: action === "exclude" ? "excluded" : "active",
      });
    }

    // An admin-set thumbnail is "manual" — mark it so the discovery thumbnail
    // retry never auto-overwrites it with a provider value.
    if (typeof patch.thumbnailUrl === "string" && patch.thumbnailUrl) {
      patch.rawJson = mergeThumbIntoRaw(patch.rawJson !== undefined ? patch.rawJson : video.rawJson, {
        status: "valid",
        attempts: 0,
        lastAttemptAt: new Date().toISOString(),
        nextRetryAt: null,
        failureReason: null,
        resolvedFrom: "manual",
      }) as Video["rawJson"];
    }

    if (changes.length === 0) {
      return NextResponse.json({ ok: true, video });
    }

    const updated = await store.updateVideo(id, patch);
    for (const change of changes) {
      await store.addOverride({
        entityType: "video",
        entityId: id,
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        reason,
      });
    }

    return NextResponse.json({ ok: true, video: updated });
  } catch (e) {
    return serverError(e, "Failed to update video");
  }
}
