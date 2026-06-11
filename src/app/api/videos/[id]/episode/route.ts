// Assign or clear a video's episode group. Internal tool — no auth; this
// mirrors the assignment controls available in /admin. Every change is
// recorded in the manual-override audit log.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await params;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || !("episodeGroupId" in body)) {
      return NextResponse.json(
        { ok: false, error: "Body must include episodeGroupId (string or null)" },
        { status: 400 },
      );
    }
    const { episodeGroupId } = body as { episodeGroupId: unknown };
    if (episodeGroupId !== null && (typeof episodeGroupId !== "string" || episodeGroupId.length === 0)) {
      return NextResponse.json(
        { ok: false, error: "episodeGroupId must be a non-empty string or null" },
        { status: 400 },
      );
    }

    const store = getStore();
    const video = await store.getVideo(id);
    if (!video) {
      return NextResponse.json({ ok: false, error: "Video not found" }, { status: 404 });
    }
    if (episodeGroupId !== null) {
      const episodes = await store.listEpisodeGroups();
      if (!episodes.some((e) => e.id === episodeGroupId)) {
        return NextResponse.json({ ok: false, error: "Episode not found" }, { status: 404 });
      }
    }

    if (video.episodeGroupId !== episodeGroupId) {
      await store.updateVideo(id, { episodeGroupId });
      await store.addOverride({
        entityType: "video",
        entityId: id,
        field: "episodeGroupId",
        oldValue: video.episodeGroupId,
        newValue: episodeGroupId,
        reason: "Episode assignment from /episodes",
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Assignment failed" },
      { status: 500 },
    );
  }
}
