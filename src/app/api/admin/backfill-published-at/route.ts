// Official YouTube Data API only. POST defaults to dry run; { confirm: true }
// writes publish dates only, preserving campaign/tracking tags and exclusions.
import { NextResponse, type NextRequest } from "next/server";
import { isAdminExcluded } from "@/lib/campaigns";
import { YouTubeApiProvider } from "@/lib/providers/youtube-api-provider";
import { getStore } from "@/lib/store";
import { parseVideoUrl } from "@/lib/url-parse";
import { asIsoDate, isAdminOrCronBearer, readJsonObject } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await readJsonObject(req)) ?? {};
    const dryRun = body.confirm !== true;
    const store = getStore();
    const missing = (await store.listVideos({ platform: "youtube", includeHidden: true }))
      .filter((v) => v.publishedAt === null);
    const candidates = missing.filter((v) => !isAdminExcluded(v));
    const counts = {
      scanned: missing.length,
      candidates: candidates.length,
      excludedSkipped: missing.length - candidates.length,
      missingId: 0, found: 0, updated: 0, unavailable: 0, failed: 0, skippedChanged: 0,
    };
    const byId = new Map<string, typeof candidates>();
    for (const video of candidates) {
      const id = video.externalVideoId ?? parseVideoUrl(video.originalUrl)?.externalVideoId;
      if (!id) { counts.missingId++; continue; }
      byId.set(id, [...(byId.get(id) ?? []), video]);
    }
    const provider = new YouTubeApiProvider();
    if (byId.size > 0 && !provider.readiness().ready) {
      return NextResponse.json({ ok: false, dryRun, ...counts, error: "YOUTUBE_API_KEY is required" }, { status: 503 });
    }
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      let metadata;
      try {
        metadata = await provider.fetchVideosByIds(batch);
      } catch {
        // Do not echo provider/network errors, which may contain credentials.
        counts.failed += batch.reduce((n, id) => n + byId.get(id)!.length, 0);
        continue;
      }
      const dates = new Map(metadata.map((v) => [v.externalVideoId, asIsoDate(v.publishedAt)]));
      for (const id of batch) {
        const publishedAt = dates.get(id);
        for (const video of byId.get(id)!) {
          if (!publishedAt) { counts.unavailable++; continue; }
          counts.found++;
          if (dryRun) continue;
          // An admin may have excluded/corrected the row during the API call.
          const current = await store.getVideo(video.id);
          if (!current || isAdminExcluded(current) || current.publishedAt !== null) {
            counts.skippedChanged++;
            continue;
          }
          await store.updateVideo(video.id, { publishedAt });
          counts.updated++;
        }
      }
    }
    return NextResponse.json({ ok: counts.failed === 0, dryRun, ...counts });
  } catch {
    return NextResponse.json({ ok: false, error: "Publish-date backfill failed" }, { status: 500 });
  }
}
