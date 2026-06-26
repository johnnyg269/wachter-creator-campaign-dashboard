// One-off, self-scoping admin helper to resolve the April Facebook reels that are
// tagged MTL but published before the June MTL floor — so they're invisible in
// both views (dropped from MTL by the floor, absent from Bootcamp by tag). The
// candidate set is DERIVED from strict criteria server-side, so the reassign
// physically cannot touch the epoch-date junk, quarantined, MTL, or Bootcamp
// records. Reassignment is a pure campaign-tag patch (keeps metrics + tracking),
// reversible via the normal admin bulk-assign tool. No Apify, no SocialCrawl.

import { campaignAssignmentPatch, campaignTag, isAdminExcluded, videoTrackingStatus } from "./campaigns";
import { bootcampStartMs, campaignStartMs } from "./eligibility";
import { computeVideoMetrics } from "./metrics";
import { getStore } from "./store";
import type { Store } from "./store/types";
import type { Video } from "./types";

export interface AprilFbCandidate {
  id: string;
  url: string;
  externalVideoId: string | null;
  platform: string;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  currentCampaign: "mtl" | "bootcamp" | "unassigned";
  trackingStatus: string;
  visibilityReason: string;
  latestViews: number | null;
  latestLikes: number | null;
  latestComments: number | null;
  latestShares: number | null;
  hasMetrics: boolean;
}

/**
 * A record qualifies iff it is a Facebook reel, currently MTL-tagged, active
 * (not hidden, not excluded), with a valid publishedAt in the window
 * [Bootcamp floor (Apr 11), MTL floor (Jun 1)). That window is exactly "published
 * after Bootcamp started but before MTL started", i.e. Bootcamp-era content that
 * the MTL floor hides and the Bootcamp tag would surface. Excludes by construction:
 * epoch/1970 records (publishedAt < Bootcamp floor), quarantined (hidden),
 * removed (excluded), June+ MTL (>= MTL floor), and anything already Bootcamp.
 */
export function isAprilFbBootcampCandidate(v: Video, now: Date = new Date()): boolean {
  if (v.platform !== "facebook") return false;
  if (v.hidden || isAdminExcluded(v)) return false;
  if (campaignTag(v) !== "mtl") return false;
  if (!v.publishedAt) return false;
  const t = Date.parse(v.publishedAt);
  if (Number.isNaN(t)) return false;
  void now;
  return t >= bootcampStartMs() && t < campaignStartMs();
}

async function detail(store: Store, v: Video, now: Date): Promise<AprilFbCandidate> {
  const snaps = await store.listSnapshots(v.id);
  const m = computeVideoMetrics(v, snaps, now);
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
      "Tagged MTL but published before the June MTL campaign floor (before_campaign_start), and not tagged Bootcamp — hidden from MTL by the floor and from Bootcamp by tag.",
    latestViews: m.confirmed.views?.value ?? null,
    latestLikes: m.confirmed.likes?.value ?? null,
    latestComments: m.confirmed.comments?.value ?? null,
    latestShares: m.confirmed.shares?.value ?? null,
    hasMetrics: m.confirmed.views?.value != null,
  };
}

/** Read-only: the candidate set with full per-record detail for review. */
export async function listAprilFbCandidates(store: Store = getStore(), now: Date = new Date()): Promise<AprilFbCandidate[]> {
  const all = await store.listVideos({ includeHidden: true });
  const cands = all.filter((v) => isAprilFbBootcampCandidate(v, now));
  return Promise.all(cands.map((v) => detail(store, v, now)));
}

export interface ReassignResult {
  candidateCount: number;
  reassigned: Array<{ id: string; url: string; from: string; to: "bootcamp" }>;
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Reassign the (re-derived) candidates to Bootcamp. Pure tag patch via
 * campaignAssignmentPatch — keeps metrics + tracking status, writes no snapshots,
 * records one audit ManualOverride per change (reversible by assigning back to
 * MTL). If `onlyIds` is provided, only candidates whose id is in that set are
 * changed (so the caller can confirm the exact reviewed set); any id not in the
 * current candidate set is ignored (never touches non-candidates).
 */
export async function reassignAprilFbToBootcamp(
  store: Store = getStore(),
  opts: { onlyIds?: string[]; reason?: string; now?: Date } = {},
): Promise<ReassignResult> {
  const now = opts.now ?? new Date();
  const all = await store.listVideos({ includeHidden: true });
  const candidates = all.filter((v) => isAprilFbBootcampCandidate(v, now));
  const onlyIds = opts.onlyIds ? new Set(opts.onlyIds) : null;
  const reassigned: ReassignResult["reassigned"] = [];
  const skipped: ReassignResult["skipped"] = [];
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
      reason: opts.reason ?? "Reassign April Facebook reel MTL→Bootcamp (Bootcamp-era content below the MTL floor)",
    });
    reassigned.push({ id: v.id, url: v.originalUrl, from: "mtl", to: "bootcamp" });
  }
  return { candidateCount: candidates.length, reassigned, skipped };
}
