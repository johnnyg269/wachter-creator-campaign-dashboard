// POST /api/admin/snapshots — manual metric snapshot (corrections / platforms
// without a live source). Records a ManualOverride audit entry.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { engagementRate } from "@/lib/metrics";
import {
  asIsoDate,
  asMetric,
  asTrimmedString,
  badRequest,
  guardAdmin,
  notFound,
  readJsonObject,
  serverError,
} from "../_utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const body = await readJsonObject(req);
  if (!body) return badRequest("Invalid JSON body");
  const videoId = asTrimmedString(body.videoId);
  if (!videoId) return badRequest("videoId is required");

  const views = asMetric(body.views);
  const likes = asMetric(body.likes);
  const comments = asMetric(body.comments);
  const shares = asMetric(body.shares);
  const saves = asMetric(body.saves);
  if (!views.ok || !likes.ok || !comments.ok || !shares.ok || !saves.ok) {
    return badRequest("Metric values must be non-negative numbers (or empty)");
  }
  if (
    views.value === null && likes.value === null && comments.value === null &&
    shares.value === null && saves.value === null
  ) {
    return badRequest("Provide at least one metric value");
  }

  try {
    const store = getStore();
    const video = await store.getVideo(videoId);
    if (!video) return notFound("Video not found");

    const metrics = {
      views: views.value,
      likes: likes.value,
      comments: comments.value,
      shares: shares.value,
      saves: saves.value,
      bookmarks: null,
    };
    const snapshot = await store.addSnapshot({
      videoId,
      capturedAt: asIsoDate(body.capturedAt) ?? new Date().toISOString(),
      ...metrics,
      engagementRate: engagementRate(metrics),
      rawJson: { manual: true },
    });
    await store.updateVideo(videoId, { lastRefreshedAt: snapshot.capturedAt });
    await store.addOverride({
      entityType: "snapshot",
      entityId: snapshot.id,
      field: "manual_snapshot",
      oldValue: null,
      newValue: JSON.stringify(metrics),
      reason: asTrimmedString(body.reason) ?? "Manual snapshot via admin",
    });
    return NextResponse.json({ ok: true, snapshot });
  } catch (e) {
    return serverError(e, "Failed to add snapshot");
  }
}
