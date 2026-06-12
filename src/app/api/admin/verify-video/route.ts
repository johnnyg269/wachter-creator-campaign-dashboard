// POST /api/admin/verify-video { videoId } — admin-only, single-video direct
// verification: runs the platform provider against the video's direct URL,
// applies the monotonic-views rule, writes a snapshot, and logs the attempt.
// One actor run per click — for spot-checking a metric against the live app.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { resolveProvider } from "@/lib/providers/registry";
import { applyMonotonicViews, engagementRate, sortSnapshots } from "@/lib/metrics";
import { asTrimmedString, badRequest, guardAdmin, notFound, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const body = await readJsonObject(req);
  const videoId = asTrimmedString(body?.videoId);
  if (!videoId) return badRequest("videoId is required");

  try {
    const store = getStore();
    const video = await store.getVideo(videoId);
    if (!video) return notFound("Video not found");

    const { provider, readiness } = await resolveProvider(video.platform, store);
    if (!readiness.ready) {
      return badRequest(`Platform source not connected (${readiness.sourceStatus})`);
    }

    const capturedAt = new Date().toISOString();
    const n = await provider.getVideoMetadata(video.originalUrl);
    await store.addCollectionAttempt({
      refreshRunId: null,
      platform: video.platform,
      provider: provider.providerType,
      actorId: null,
      kind: "verify",
      inputDescription: `admin verify-now: ${video.originalUrl.slice(0, 80)}`,
      success: Boolean(n),
      runId: null,
      itemCount: n ? 1 : 0,
      error: n ? null : "Source returned no usable item for the direct URL",
      capturedAt,
    });
    if (!n) {
      return NextResponse.json({
        ok: true,
        verified: false,
        message: "The source returned no usable data for this video's direct URL.",
      });
    }

    // Monotonic views: a lower direct reading than the last confirmed value
    // is source fluctuation — record null rather than a false decrease.
    const prev = sortSnapshots(await store.listSnapshots(video.id))
      .reverse()
      .find((s) => s.views !== null);
    const { views, rejectedLower } = applyMonotonicViews(n.views, prev?.views ?? null);

    await store.addSnapshot({
      videoId: video.id,
      capturedAt,
      views,
      likes: n.likes,
      comments: n.comments,
      shares: n.shares,
      saves: n.saves,
      bookmarks: n.bookmarks,
      engagementRate: engagementRate({ ...n, views }),
      rawJson: { verifiedByAdmin: true },
    });
    await store.updateVideo(video.id, {
      lastRefreshedAt: capturedAt,
      thumbnailUrl: video.thumbnailUrl ?? n.thumbnailUrl,
      caption: n.caption ?? video.caption,
      publishedAt: video.publishedAt ?? n.publishedAt,
    });

    return NextResponse.json({
      ok: true,
      verified: true,
      values: { views, likes: n.likes, comments: n.comments, shares: n.shares },
      rejectedLowerViews: rejectedLower,
    });
  } catch (e) {
    return serverError(e, "Verification failed");
  }
}
