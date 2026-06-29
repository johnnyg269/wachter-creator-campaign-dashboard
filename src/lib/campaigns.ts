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

/** Admin/campaign-controlled rawJson keys that a provider refresh must NOT clobber. */
const ADMIN_RAW_KEYS = ["campaign", "tracking", "discoveryReview", "discoveryReviewReason"] as const;

/**
 * Carry admin/campaign-controlled rawJson keys (campaign tag, tracking status,
 * discovery-review flags) from the EXISTING record onto a FRESH provider payload.
 * A metrics refresh rewrites rawJson from the provider, which does not include
 * these admin-set fields — without this, every refresh silently drops a video's
 * campaign tag (reverting Bootcamp → untagged → MTL default) and its removed-from-
 * tracking state. Returns a new object; never mutates inputs.
 */
export function carryOverAdminTags(existingRaw: unknown, freshRaw: unknown): Record<string, unknown> {
  const existing = existingRaw && typeof existingRaw === "object" ? (existingRaw as Record<string, unknown>) : {};
  const fresh = freshRaw && typeof freshRaw === "object" ? { ...(freshRaw as Record<string, unknown>) } : {};
  for (const k of ADMIN_RAW_KEYS) {
    if (k in existing) fresh[k] = existing[k];
    else delete fresh[k]; // existing had none → ensure the fresh payload doesn't invent one
  }
  return fresh;
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

/**
 * Raw campaign tag IGNORING exclusion — for eligibility-floor decisions on the
 * restore path. Unlike videoCampaign (where exclusion dominates → null), an
 * excluded Bootcamp record still reports "bootcamp" here, so the manual-add
 * restore flow uses the April Bootcamp floor (not the June MTL floor) when an
 * admin restores it. Untagged → "mtl" (migration default); "unassigned" → null.
 */
export function campaignTag(v: RawWithTags): CampaignSlug | null {
  const tag = rawObj(v).campaign;
  if (tag === "mtl" || tag === "bootcamp") return tag;
  if (tag === "unassigned") return null;
  return "mtl";
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
