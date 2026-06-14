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

  await seedDefaultEpisodes(store, campaign.id);

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

/**
 * Seed the default content concepts ONLY at true initial setup.
 *
 * Bug fix (2026-06-13): `ensureSeedData` runs on every page load (via
 * getHealth) and every refresh. The old code unconditionally upserted every
 * DEFAULT_EPISODE_GROUPS name, so a concept an admin had deleted was recreated
 * with a fresh id + createdAt and reappeared at the bottom of the list.
 *
 * New rule: if ANY episode group already exists, do nothing — admin is the
 * sole authority over the concept list from then on, and deletes are
 * permanent. On a truly empty list (first run, or every concept deleted) we
 * still skip any default whose most recent admin action was a delete
 * (tombstone), so deleted defaults never resurrect.
 */
async function seedDefaultEpisodes(store: Store, campaignId: string): Promise<void> {
  const existing = await store.listEpisodeGroups();
  if (existing.length > 0) return; // already initialized — never recreate/duplicate

  const tombstoned = await tombstonedEpisodeNames(store);
  for (const name of DEFAULT_EPISODE_GROUPS) {
    if (tombstoned.has(name)) {
      console.info(`[seed] skipping default concept "${name}" — previously deleted (tombstone)`);
      continue;
    }
    await store.upsertEpisodeGroupByName({ campaignId, name, description: null });
  }
}

/**
 * Names whose most recent episode admin action was a delete. Derived from the
 * ManualOverride audit log (entityType "episode") — a durable tombstone that
 * needs no schema change. The admin routes write `created` (newValue=name) and
 * `deleted` (oldValue=name) rows; the latest action per name wins, so a
 * delete → recreate → delete sequence resolves correctly.
 */
async function tombstonedEpisodeNames(store: Store): Promise<Set<string>> {
  const overrides = await store.listOverrides(1000);
  const latest = new Map<string, { at: string; deleted: boolean }>();
  for (const o of overrides) {
    if (o.entityType !== "episode") continue;
    const name = o.field === "created" ? o.newValue : o.field === "deleted" ? o.oldValue : null;
    if (!name) continue;
    const prev = latest.get(name);
    if (!prev || o.createdAt > prev.at) {
      latest.set(name, { at: o.createdAt, deleted: o.field === "deleted" });
    }
  }
  const out = new Set<string>();
  for (const [name, v] of latest) if (v.deleted) out.add(name);
  return out;
}

/** Effective discovery cutoff: campaign start, else earliest seed publish, else 30d back. */
export function effectiveStartDate(campaign: Campaign, fallbackDays = 30): Date {
  if (campaign.startDate) return new Date(campaign.startDate);
  return new Date(Date.now() - fallbackDays * 24 * 3600 * 1000);
}
