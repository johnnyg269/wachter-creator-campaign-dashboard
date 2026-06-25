// Campaign model + per-video campaign tagging and tracking status.
//
// SCHEMA-FREE by design: the production Postgres schema can't be migrated from
// the build env, and this codebase already stores per-video state in the
// existing `rawJson` column (thumbnail state, discovery-review flag). Campaign
// assignment and tracking status live there too:
//   rawJson.campaign  = "mtl" | "bootcamp" | "unassigned"   (unset → MTL default)
//   rawJson.tracking  = { status: "excluded"|"active", excludedAt?, excludedBy?,
//                         reason?, restoredAt?, restoredBy? }
// The Campaign *definitions* (slug/status/refresh tier) are code-level — there
// is no per-campaign DB row to migrate.

import { isReviewCandidate } from "./eligibility";

export type CampaignSlug = "mtl" | "bootcamp";
/** Filter values used across pages + admin. "unassigned" is admin-only. */
export type CampaignFilter = "all" | CampaignSlug | "unassigned";
export type TrackingStatus = "active" | "excluded" | "review";

export interface CampaignDef {
  id: CampaignSlug;
  slug: CampaignSlug;
  name: string;
  status: "active" | "archived";
  /** Refresh-tier family (Option B wiring lands in Phase 2; recorded here now). */
  defaultRefreshTier: "hot_warm" | "daily";
}

export const CAMPAIGNS: CampaignDef[] = [
  { id: "mtl", slug: "mtl", name: "MTL Campaign", status: "active", defaultRefreshTier: "hot_warm" },
  { id: "bootcamp", slug: "bootcamp", name: "Bootcamp Campaign", status: "archived", defaultRefreshTier: "daily" },
];

export const CAMPAIGN_SLUGS: CampaignSlug[] = ["mtl", "bootcamp"];
export function campaignName(slug: CampaignSlug | null): string {
  if (slug === null) return "Unassigned";
  return CAMPAIGNS.find((c) => c.slug === slug)?.name ?? slug;
}
export function isCampaignSlug(v: unknown): v is CampaignSlug {
  return v === "mtl" || v === "bootcamp";
}

interface RawWithTags {
  rawJson?: unknown;
}
function rawObj(v: RawWithTags): Record<string, unknown> {
  return v.rawJson && typeof v.rawJson === "object" ? (v.rawJson as Record<string, unknown>) : {};
}

/** Admin deliberately removed this video from tracking (soft delete). */
export function isAdminExcluded(v: RawWithTags): boolean {
  const t = rawObj(v).tracking as { status?: string } | undefined;
  return t?.status === "excluded";
}

/**
 * The video's campaign. Reads rawJson.campaign; an explicit "unassigned" → null.
 * MIGRATION DEFAULT: an untagged video that is NOT admin-excluded counts as MTL
 * (the existing campaign) — so current tracked content shows under MTL with no
 * data write. Admin-excluded / explicitly-unassigned videos are never auto-MTL.
 */
export function videoCampaign(v: RawWithTags): CampaignSlug | null {
  // Admin exclusion DOMINATES: an excluded video is campaign===null regardless
  // of any (possibly stale) explicit tag, so it drops out of every public scope.
  if (isAdminExcluded(v)) return null;
  const tag = rawObj(v).campaign;
  if (tag === "mtl" || tag === "bootcamp") return tag;
  if (tag === "unassigned") return null;
  return "mtl"; // migration default for untagged, non-excluded videos
}

export function videoTrackingStatus(v: RawWithTags): TrackingStatus {
  if (isAdminExcluded(v)) return "excluded";
  if (isReviewCandidate(v)) return "review";
  return "active";
}

/** Reason an admin gave when removing the video from tracking. */
export function excludeReason(v: RawWithTags): string | null {
  const t = rawObj(v).tracking as { reason?: string } | undefined;
  return typeof t?.reason === "string" ? t.reason : null;
}

/**
 * Whether a (campaign-resolved) video passes the active campaign filter.
 * Operates on the RESOLVED campaign value so it works on page-facing scoped
 * videos (whose rawJson is stripped but carry a derived `campaign` field).
 *  - all       → any assigned video (mtl or bootcamp); excludes unassigned
 *  - mtl       → MTL only
 *  - bootcamp  → Bootcamp only
 *  - unassigned→ unassigned only (admin)
 */
export function matchesCampaign(campaign: CampaignSlug | null, filter: CampaignFilter): boolean {
  switch (filter) {
    case "all":
      return campaign !== null;
    case "mtl":
      return campaign === "mtl";
    case "bootcamp":
      return campaign === "bootcamp";
    case "unassigned":
      return campaign === null;
  }
}

/** Parse a ?campaign= value into a safe CampaignFilter (default "all").
 *  Admin contexts only — accepts "unassigned". */
export function parseCampaignFilter(v: unknown): CampaignFilter {
  return v === "mtl" || v === "bootcamp" || v === "unassigned" ? v : "all";
}

/** PUBLIC pages: "unassigned" is an admin-only scope, so collapse it to "all"
 *  (never surface admin-unassigned videos on a hand-typed public URL). */
export function parsePublicCampaignFilter(v: unknown): CampaignFilter {
  return v === "mtl" || v === "bootcamp" ? v : "all";
}

/** Build the rawJson patch for a campaign assignment (merged into existing raw). */
export function campaignAssignmentPatch(
  rawJson: unknown,
  slug: CampaignSlug | "unassigned",
): Record<string, unknown> {
  const base = rawJson && typeof rawJson === "object" ? { ...(rawJson as Record<string, unknown>) } : {};
  base.campaign = slug;
  return base;
}

/** Build the rawJson patch for remove-from-tracking / restore. */
export function trackingPatch(
  rawJson: unknown,
  action: "exclude" | "restore",
  meta: { reason?: string; by?: string; now: string },
): Record<string, unknown> {
  const base = rawJson && typeof rawJson === "object" ? { ...(rawJson as Record<string, unknown>) } : {};
  const prev = (base.tracking && typeof base.tracking === "object" ? base.tracking : {}) as Record<string, unknown>;
  base.tracking =
    action === "exclude"
      ? { ...prev, status: "excluded", excludedAt: meta.now, excludedBy: meta.by ?? null, reason: meta.reason ?? null }
      : { ...prev, status: "active", restoredAt: meta.now, restoredBy: meta.by ?? null };
  return base;
}
