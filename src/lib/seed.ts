// Idempotent seeding: campaign, the four platform profiles, the four seed
// videos, and the default episode groups. Runs at the start of every refresh
// and on first page load, so the app works before any data source is wired up.

import {
  DEFAULT_EPISODE_GROUPS,
  SEED_CAMPAIGN,
  SEED_PROFILES,
  SEED_VIDEOS,
} from "./config";
import type { Campaign } from "./types";
import type { Store } from "./store/types";
import { parseProfileUrl, parseVideoUrl, tiktokPublishedAtFromId } from "./url-parse";
import { resolveProvider } from "./providers/registry";

export async function ensureSeedData(store: Store): Promise<Campaign> {
  const campaign = await store.upsertCampaign({
    name: SEED_CAMPAIGN.name,
    creatorName: SEED_CAMPAIGN.creatorName,
    company: SEED_CAMPAIGN.company,
    startDate: null,
  });

  for (const name of DEFAULT_EPISODE_GROUPS) {
    await store.upsertEpisodeGroupByName({ campaignId: campaign.id, name, description: null });
  }

  const profileIdByPlatform = new Map<string, string>();
  for (const seed of SEED_PROFILES) {
    const parsed = parseProfileUrl(seed.url);
    const { readiness } = await resolveProvider(seed.platform, store);
    const profile = await store.upsertProfileByUrl({
      campaignId: campaign.id,
      platform: seed.platform,
      profileUrl: seed.url,
      handle: parsed?.handle ?? null,
      externalProfileId: parsed?.externalProfileId ?? null,
      lastDiscoveredAt: null,
      status: readiness.sourceStatus,
    });
    profileIdByPlatform.set(seed.platform, profile.id);
  }

  const now = new Date().toISOString();
  for (const seed of SEED_VIDEOS) {
    const parsed = parseVideoUrl(seed.url);
    const existing = await store.findVideoByUrlOrExternalId(
      seed.platform,
      parsed?.canonicalUrl ?? seed.url,
      parsed?.externalVideoId ?? null,
    );
    if (existing) continue;
    const { readiness } = await resolveProvider(seed.platform, store);
    await store.insertVideo({
      campaignId: campaign.id,
      platform: seed.platform,
      profileId: profileIdByPlatform.get(seed.platform) ?? null,
      originalUrl: parsed?.canonicalUrl ?? seed.url,
      externalVideoId: parsed?.externalVideoId ?? null,
      title: null,
      caption: null,
      thumbnailUrl: null,
      publishedAt:
        seed.platform === "tiktok" && parsed?.externalVideoId
          ? tiktokPublishedAtFromId(parsed.externalVideoId)
          : null,
      firstTrackedAt: now,
      lastRefreshedAt: null,
      status: "active",
      episodeGroupId: null,
      sourceStatus: readiness.ready ? "waiting" : readiness.sourceStatus,
      errorMessage: null,
      hidden: false,
      isSeed: true,
      rawJson: null,
    });
  }

  // Campaign start = earliest known seed publish date (admin-editable).
  if (!campaign.startDate) {
    const videos = await store.listVideos({ includeHidden: true });
    const seedDates = videos
      .filter((v) => v.isSeed && v.publishedAt)
      .map((v) => v.publishedAt as string)
      .sort();
    if (seedDates.length > 0) {
      return store.updateCampaign(campaign.id, { startDate: seedDates[0] });
    }
  }
  return campaign;
}

/** Effective discovery cutoff: campaign start, else earliest seed publish, else 30d back. */
export function effectiveStartDate(campaign: Campaign, fallbackDays = 30): Date {
  if (campaign.startDate) return new Date(campaign.startDate);
  return new Date(Date.now() - fallbackDays * 24 * 3600 * 1000);
}
