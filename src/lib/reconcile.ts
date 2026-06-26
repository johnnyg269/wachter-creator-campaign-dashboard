// Read-only campaign reconciliation. The ACTIVE/public numbers are produced by
// calling loadCampaignData (THE same chokepoint that feeds every public total /
// list / chart), so they equal what the live dashboard shows by construction —
// no predicate is re-implemented. A separate raw-record pass over the full store
// (including hidden/excluded) explains any gap between total records and the
// active public count. Pure reads — never writes, never touches snapshots, and
// is independent of credit / refresh / estimated-trend logic.

import { campaignTag, isAdminExcluded } from "./campaigns";
import { eligibilityFloorForCampaign, ineligibilityReason, isReviewCandidate, UNASSIGNED_EPISODE_NAME } from "./eligibility";
import { loadCampaignData } from "./queries";
import { getStore } from "./store";
import type { Store } from "./store/types";
import type { Platform } from "./types";

type Campaign = "bootcamp" | "mtl";

const PLATFORMS: Platform[] = ["tiktok", "instagram", "facebook", "youtube"];
const emptyByPlatform = (): Record<Platform, number> => ({ tiktok: 0, instagram: 0, facebook: 0, youtube: 0 });

/** One non-active record, for explaining the total-vs-active gap (no PII / no rawJson). */
export interface DroppedRecord {
  tag: Campaign;
  platform: Platform;
  publishedAt: string | null;
  hidden: boolean;
  excluded: boolean;
  reason: string;
}

export interface CampaignReconcile {
  campaign: Campaign;
  /** Videos counted in the public dashboard total for this campaign (mirror of loadCampaignData). */
  activePublicCount: number;
  /** Sum of last-confirmed views over the active set (== buildKpis.totalViews). */
  activeTotalViews: number | null;
  /** Active videos whose confirmed views are still null (pending a first reading). */
  activeMissingMetricsCount: number;
  /** All records intended for this campaign (campaignTag), incl. excluded/hidden/ineligible. */
  totalRecords: number;
  /** Records intended for this campaign that are admin-excluded (removed from tracking). */
  excludedCount: number;
  /** totalRecords − activePublicCount. */
  droppedFromActive: number;
  /** Why each non-active record is excluded from the active count (sums to droppedFromActive). */
  dropReasons: Record<string, number>;
  /** Active public videos per platform (sums to activePublicCount). */
  activeByPlatform: Record<Platform, number>;
  /** All tagged records per platform (sums to totalRecords). */
  recordsByPlatform: Record<Platform, number>;
}

export interface ReconcileResult {
  generatedAt: string;
  bootcamp: CampaignReconcile;
  mtl: CampaignReconcile;
  allActivePublicCount: number;
  allActiveTotalViews: number | null;
  /** Active videos across all campaigns with no confirmed views yet. */
  pendingMetricsTotal: number;
  /** Records explicitly set to "unassigned" (admin-only; campaignTag === null, not excluded). */
  unassignedAdminOnlyCount: number;
  /** All admin-excluded/removed records (any campaign). */
  excludedGlobalCount: number;
  /** Newest snapshot timestamp across the active set, or null. */
  lastUpdated: string | null;
  /** Every bootcamp/mtl-tagged record NOT in the active set, with its drop reason. */
  droppedRecords: DroppedRecord[];
  invariants: {
    /** all views === bootcamp views + mtl views. */
    allViewsEqualsBootcampPlusMtl: boolean;
    /** all active count === bootcamp + mtl active counts. */
    allCountEqualsBootcampPlusMtl: boolean;
    /** No video appears in both the active Bootcamp and active MTL sets. */
    noVideoInTwoCampaigns: boolean;
    /** No active video is removed-from-tracking (excluded). */
    noExcludedInActive: boolean;
    /** No active video is unassigned (resolved campaign null). */
    noUnassignedInActive: boolean;
    /** Every active-Bootcamp video resolves to campaign "bootcamp" (no MTL bleed-in). */
    noMtlRecordInBootcampActive: boolean;
  };
}

/** Sum that skips nulls and returns null only when every value is null (== sumNullable in queries). */
function sumViews(vals: Array<number | null>): number | null {
  let sum = 0;
  let any = false;
  for (const v of vals) {
    if (v !== null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

export async function reconcileCampaigns(store: Store = getStore(), now: Date = new Date()): Promise<ReconcileResult> {
  // Active/public sets — exactly what the dashboard renders for each filter.
  const [bootcampData, mtlData, allData] = await Promise.all([
    loadCampaignData(false, "bootcamp"),
    loadCampaignData(false, "mtl"),
    loadCampaignData(false, "all"),
  ]);

  // Raw record pass (everything, incl. hidden/excluded) + episode context, to
  // classify why a record is or is not in the active set.
  const allRecords = await store.listVideos({ includeHidden: true });
  const episodes = await store.listEpisodeGroups();
  const unassignedId = episodes.find((e) => e.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;

  const activeIds = { bootcamp: new Set(bootcampData.videos.map((v) => v.id)), mtl: new Set(mtlData.videos.map((v) => v.id)) };

  const droppedRecords: DroppedRecord[] = [];

  const perCampaign = (campaign: Campaign): CampaignReconcile => {
    const data = campaign === "bootcamp" ? bootcampData : mtlData;
    const activePublicCount = data.videos.length;
    const viewVals = data.videos.map((v) => data.metricsByVideo.get(v.id)?.confirmed.views?.value ?? null);
    const activeTotalViews = sumViews(viewVals);
    const activeMissingMetricsCount = viewVals.filter((v) => v === null).length;
    const activeByPlatform = emptyByPlatform();
    for (const v of data.videos) if (PLATFORMS.includes(v.platform)) activeByPlatform[v.platform] += 1;

    const tagged = allRecords.filter((v) => campaignTag(v) === campaign);
    const excludedCount = tagged.filter((v) => isAdminExcluded(v)).length;
    const recordsByPlatform = emptyByPlatform();
    for (const v of tagged) if (PLATFORMS.includes(v.platform)) recordsByPlatform[v.platform] += 1;
    const activeSet = activeIds[campaign];
    const dropReasons: Record<string, number> = {};
    for (const v of tagged) {
      if (activeSet.has(v.id)) continue; // counted in the active total
      const reason = isAdminExcluded(v)
        ? "excluded"
        : v.hidden
          ? "hidden_or_quarantined"
          : isReviewCandidate(v)
            ? "discovery_review"
            : (ineligibilityReason(v, eligibilityFloorForCampaign(campaign), unassignedId) ?? "filtered_other");
      dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
      droppedRecords.push({
        tag: campaign,
        platform: v.platform,
        publishedAt: v.publishedAt,
        hidden: v.hidden,
        excluded: isAdminExcluded(v),
        reason,
      });
    }
    return {
      campaign,
      activePublicCount,
      activeTotalViews,
      activeMissingMetricsCount,
      totalRecords: tagged.length,
      excludedCount,
      droppedFromActive: tagged.length - activePublicCount,
      dropReasons,
      activeByPlatform,
      recordsByPlatform,
    };
  };

  const bootcamp = perCampaign("bootcamp");
  const mtl = perCampaign("mtl");

  // "all" computed independently (loadCampaignData(false,"all")) so the invariant
  // is a real cross-check, not a tautology.
  const allViewVals = allData.videos.map((v) => allData.metricsByVideo.get(v.id)?.confirmed.views?.value ?? null);
  const allActivePublicCount = allData.videos.length;
  const allActiveTotalViews = sumViews(allViewVals);
  const pendingMetricsTotal = allViewVals.filter((v) => v === null).length;

  const unassignedAdminOnlyCount = allRecords.filter((v) => campaignTag(v) === null && !isAdminExcluded(v)).length;
  const excludedGlobalCount = allRecords.filter((v) => isAdminExcluded(v)).length;

  // Newest snapshot across the active set.
  let lastUpdated: string | null = null;
  for (const snaps of allData.snapshotsByVideo.values()) {
    for (const s of snaps) {
      if (lastUpdated === null || s.capturedAt > lastUpdated) lastUpdated = s.capturedAt;
    }
  }

  const noVideoInTwoCampaigns = [...activeIds.bootcamp].every((id) => !activeIds.mtl.has(id));
  const sumViewsBM = sumViews([bootcamp.activeTotalViews, mtl.activeTotalViews]);

  return {
    generatedAt: now.toISOString(),
    bootcamp,
    mtl,
    allActivePublicCount,
    allActiveTotalViews,
    pendingMetricsTotal,
    unassignedAdminOnlyCount,
    excludedGlobalCount,
    lastUpdated,
    droppedRecords,
    invariants: {
      allViewsEqualsBootcampPlusMtl: allActiveTotalViews === sumViewsBM,
      allCountEqualsBootcampPlusMtl: allActivePublicCount === bootcamp.activePublicCount + mtl.activePublicCount,
      noVideoInTwoCampaigns,
      noExcludedInActive: allData.videos.every((v) => v.trackingStatus !== "excluded"),
      noUnassignedInActive: allData.videos.every((v) => v.campaign !== null),
      noMtlRecordInBootcampActive: bootcampData.videos.every((v) => v.campaign === "bootcamp"),
    },
  };
}
