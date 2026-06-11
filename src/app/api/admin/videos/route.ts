// POST /api/admin/videos { url, episodeGroupId? } → detect the platform from
// the URL and start tracking the video (manual provider metadata until the
// next refresh fills it in).

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { ensureSeedData } from "@/lib/seed";
import { resolveProvider } from "@/lib/providers/registry";
import { parseVideoUrl, tiktokPublishedAtFromId } from "@/lib/url-parse";
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
    if (!url) return badRequest("A video URL is required");

    const parsed = parseVideoUrl(url);
    if (!parsed) {
      return badRequest(
        "Unrecognized URL — paste a TikTok, YouTube Shorts, Instagram Reel, or Facebook Reel link",
      );
    }

    const store = getStore();
    const campaign = await ensureSeedData(store);

    const existing = await store.findVideoByUrlOrExternalId(
      parsed.platform,
      parsed.canonicalUrl,
      parsed.externalVideoId,
    );
    if (existing) {
      return NextResponse.json(
        { ok: false, error: "This video is already tracked" },
        { status: 409 },
      );
    }

    const episodeGroupId = asTrimmedString(body.episodeGroupId);
    if (episodeGroupId) {
      const episodes = await store.listEpisodeGroups();
      if (!episodes.some((e) => e.id === episodeGroupId)) {
        return badRequest("Unknown episode group");
      }
    }

    const profiles = await store.listProfiles();
    const profile = profiles.find((p) => p.platform === parsed.platform) ?? null;
    const { readiness } = await resolveProvider(parsed.platform, store);

    const video = await store.insertVideo({
      campaignId: campaign.id,
      platform: parsed.platform,
      profileId: profile?.id ?? null,
      originalUrl: parsed.canonicalUrl,
      externalVideoId: parsed.externalVideoId,
      title: null,
      caption: null,
      thumbnailUrl: null,
      publishedAt:
        parsed.platform === "tiktok" && parsed.externalVideoId
          ? tiktokPublishedAtFromId(parsed.externalVideoId)
          : null,
      firstTrackedAt: new Date().toISOString(),
      lastRefreshedAt: null,
      status: "active",
      episodeGroupId,
      sourceStatus: readiness.ready ? "waiting" : readiness.sourceStatus,
      errorMessage: null,
      hidden: false,
      isSeed: false,
      rawJson: null,
    });

    return NextResponse.json({ ok: true, video });
  } catch (e) {
    return serverError(e, "Failed to add video");
  }
}
