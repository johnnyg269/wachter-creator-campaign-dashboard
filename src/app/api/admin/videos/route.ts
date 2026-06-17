// POST /api/admin/videos { url, episodeGroupId? } → detect the platform from
// the URL and start tracking the video (manual provider metadata until the
// next refresh fills it in).

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { ensureSeedData } from "@/lib/seed";
import { resolveProvider } from "@/lib/providers/registry";
import { parseVideoUrl, tiktokPublishedAtFromId } from "@/lib/url-parse";
import type { Video } from "@/lib/types";
import {
  campaignStartMs,
  ineligibilityReason,
  isCampaignEligible,
  isReviewCandidate,
  UNASSIGNED_EPISODE_NAME,
} from "@/lib/eligibility";
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
      const startMs = campaignStartMs();
      const eps = await store.listEpisodeGroups();
      const unassignedId = eps.find((e) => e.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;
      const review = isReviewCandidate(existing);
      const eligInput = (publishedAt: string | null) => ({
        platform: parsed.platform,
        originalUrl: existing.originalUrl,
        publishedAt,
        isSeed: false,
        episodeGroupId: null as string | null,
      });
      const visible = !existing.hidden && !review && isCampaignEligible(existing, startMs, unassignedId);
      if (visible) {
        return NextResponse.json(
          { ok: false, state: "visible", videoId: existing.id, error: "This video is already tracked and visible in the campaign." },
          { status: 409 },
        );
      }
      // Hidden / excluded / review / corrupt-date: don't dead-end — restore it if
      // it's a valid campaign video. Keep its existing eligible date, else derive
      // the TikTok publish date from the snowflake id, else leave as-is.
      const existingDateOk = Boolean(existing.publishedAt) && isCampaignEligible(eligInput(existing.publishedAt), startMs, null);
      const derived = parsed.platform === "tiktok" && parsed.externalVideoId ? tiktokPublishedAtFromId(parsed.externalVideoId) : null;
      const restoreDate = existingDateOk ? existing.publishedAt : derived;
      const eligibleAfter = Boolean(restoreDate) && isCampaignEligible(eligInput(restoreDate), startMs, null);
      if (eligibleAfter) {
        const rawObj = existing.rawJson && typeof existing.rawJson === "object" ? { ...(existing.rawJson as Record<string, unknown>) } : {};
        delete rawObj.discoveryReview;
        delete rawObj.discoveryReviewReason;
        const restored = await store.updateVideo(existing.id, {
          hidden: false,
          status: "active",
          sourceStatus: "live",
          errorMessage: null,
          publishedAt: restoreDate,
          rawJson: rawObj as Video["rawJson"],
        });
        await store.addOverride({
          entityType: "video",
          entityId: existing.id,
          field: "restored",
          oldValue: review ? "review" : existing.hidden ? "hidden" : "excluded",
          newValue: "active",
          reason: "manual add matched an existing hidden/excluded record — restored",
        });
        return NextResponse.json({
          ok: true,
          restored: true,
          video: restored,
          message: "This video already existed but was hidden/excluded — restored to active campaign tracking. Metrics and thumbnail refresh on the next pull.",
        });
      }
      // Genuinely out-of-campaign (e.g. published before the campaign start).
      const why = ineligibilityReason(eligInput(existing.publishedAt), startMs, null);
      return NextResponse.json(
        {
          ok: false,
          state: "excluded",
          videoId: existing.id,
          reason: why,
          error: `This video already exists but is out-of-campaign (${why ?? "ineligible"}); it stays excluded. Adjust the campaign start or the record in admin to include it.`,
        },
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
