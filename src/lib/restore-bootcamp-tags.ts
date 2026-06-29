// Recover "stranded" Bootcamp videos: records currently tagged MTL (or untagged→
// MTL) and published in the Bootcamp window [Bootcamp floor, MTL floor). Because
// the MTL campaign only began at the MTL floor, an MTL-tagged video published
// before it cannot be genuine MTL content — it is Bootcamp-era content whose
// "bootcamp" tag was lost (e.g. a refresh that overwrote rawJson.campaign). The
// candidate set is DERIVED from strict criteria server-side, so the action cannot
// touch epoch-date junk, quarantined, removed, June+ MTL, or already-Bootcamp
// records. Reassignment is a pure campaign-tag patch (keeps metrics + tracking),
// reversible via the normal admin bulk-assign tool. No Apify, no SocialCrawl.

import { campaignAssignmentPatch, campaignTag, isAdminExcluded, videoTrackingStatus } from "./campaigns";
import { bootcampStartMs, campaignStartMs } from "./eligibility";
import { computeVideoMetrics } from "./metrics";
import { getStore } from "./store";
import type { Store } from "./store/types";
import type { Platform, Video } from "./types";

export interface StrandedBootcampCandidate {
  id: string;
  url: string;
  externalVideoId: string | null;
  platform: Platform;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  currentCampaign: "mtl";
  trackingStatus: string;
  visibilityReason: string;
  latestViews: number | null;
  latestLikes: number | null;
  latestComments: number | null;
  latestShares: number | null;
  hasMetrics: boolean;
}

/**
 * A record qualifies iff it is currently MTL-tagged (or untagged→MTL), active
 * (not hidden, not excluded), with a valid publishedAt in [Bootcamp floor, MTL
 * floor). Excludes by construction: epoch/1970 (publishedAt < Bootcamp floor),
 * quarantined (hidden), removed (excluded), June+ MTL (>= MTL floor), and anything
 * already Bootcamp. Platform-agnostic — the campaign-tag corruption hit every
 * platform (TikTok / Instagram / Facebook / YouTube).
 */
export function isStrandedBootcampCandidate(v: Video): boolean {
  if (v.hidden || isAdminExcluded(v)) return false;
  if (campaignTag(v) !== "mtl") return false;
  if (!v.publishedAt) return false;
  const t = Date.parse(v.publishedAt);
  if (Number.isNaN(t)) return false;
  return t >= bootcampStartMs() && t < campaignStartMs();
}

async function detail(store: Store, v: Video, now: Date): Promise<StrandedBootcampCandidate> {
  const m = computeVideoMetrics(v, await store.listSnapshots(v.id), now);
  return {
    id: v.id,
    url: v.originalUrl,
    externalVideoId: v.externalVideoId,
    platform: v.platform,
    title: v.title,
    caption: v.caption,
    thumbnailUrl: v.thumbnailUrl,
    publishedAt: v.publishedAt,
    currentCampaign: "mtl",
    trackingStatus: videoTrackingStatus(v),
    visibilityReason:
      "Tagged MTL but published before the MTL campaign floor (before_campaign_start), and not tagged Bootcamp — hidden from MTL by the floor and from Bootcamp by tag. MTL did not exist this early, so this is Bootcamp-era content whose tag was lost.",
    latestViews: m.confirmed.views?.value ?? null,
    latestLikes: m.confirmed.likes?.value ?? null,
    latestComments: m.confirmed.comments?.value ?? null,
    latestShares: m.confirmed.shares?.value ?? null,
    hasMetrics: m.confirmed.views?.value != null,
  };
}

/** Read-only: the candidate set with full per-record detail for review. */
export async function listStrandedBootcampCandidates(store: Store = getStore(), now: Date = new Date()): Promise<StrandedBootcampCandidate[]> {
  const all = await store.listVideos({ includeHidden: true });
  return Promise.all(all.filter(isStrandedBootcampCandidate).map((v) => detail(store, v, now)));
}

export interface RestoreResult {
  candidateCount: number;
  reassigned: Array<{ id: string; url: string; platform: Platform; from: string; to: "bootcamp" }>;
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Reassign the (re-derived) candidates to Bootcamp. Pure tag patch via
 * campaignAssignmentPatch — keeps metrics + tracking, writes no snapshots, records
 * one audit ManualOverride per change (reversible by assigning back to MTL). When
 * `onlyIds` is given, only candidates whose id is in that set are changed; any id
 * not in the current candidate set is ignored (never touches non-candidates).
 */
export async function restoreStrandedBootcampTags(
  store: Store = getStore(),
  opts: { onlyIds?: string[]; reason?: string; now?: Date } = {},
): Promise<RestoreResult> {
  const now = opts.now ?? new Date();
  const candidates = (await store.listVideos({ includeHidden: true })).filter(isStrandedBootcampCandidate);
  const onlyIds = opts.onlyIds ? new Set(opts.onlyIds) : null;
  const reassigned: RestoreResult["reassigned"] = [];
  const skipped: RestoreResult["skipped"] = [];
  for (const v of candidates) {
    if (onlyIds && !onlyIds.has(v.id)) {
      skipped.push({ id: v.id, reason: "not in confirmed id set" });
      continue;
    }
    await store.updateVideo(v.id, { rawJson: campaignAssignmentPatch(v.rawJson, "bootcamp") as Video["rawJson"] });
    await store.addOverride({
      entityType: "video",
      entityId: v.id,
      field: "campaign",
      oldValue: "mtl",
      newValue: "bootcamp",
      reason: opts.reason ?? "Restore stranded Bootcamp tag (lost to refresh rawJson overwrite)",
    });
    reassigned.push({ id: v.id, url: v.originalUrl, platform: v.platform, from: "mtl", to: "bootcamp" });
  }
  return { candidateCount: candidates.length, reassigned, skipped };
}
