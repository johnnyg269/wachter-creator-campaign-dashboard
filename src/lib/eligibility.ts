// Campaign eligibility — the single source of truth for "does this video count
// as active campaign content?". Applied at read time (loadCampaignData, alerts)
// so out-of-campaign / corrupt records never reach dashboard, reports, platform
// totals, milestones, or charts; and at the refresh boundary so unmatched
// profile-feed items are never auto-imported.
//
// Background: SocialCrawl's profile endpoints return the creator's WHOLE recent
// feed, and an earlier bug stored Unix-seconds dates as "Jan 1970". The rules
// below quarantine those records by rule alone — no schema migration, no
// destructive delete, fully reversible by adjusting CAMPAIGN_START_DATE_ET.

import { getBootcampStartDateEt, getCampaignStartDateEt } from "./config";
import type { Platform, Video } from "./types";

/** Platforms this campaign tracks. */
const SUPPORTED_PLATFORMS: readonly Platform[] = ["tiktok", "instagram", "facebook", "youtube"];

/** The default "Other / unassigned" episode bucket is NOT a real assignment. */
export const UNASSIGNED_EPISODE_NAME = "Other / unassigned";

/** Any real social post is well after this; earlier ⇒ garbage/epoch date. */
const MIN_PLAUSIBLE_YEAR = 2005;

export type IneligibilityReason =
  | "date_missing"
  | "date_invalid"
  | "before_campaign_start"
  | "unsupported_platform"
  | "no_canonical_url";

export const INELIGIBILITY_LABELS: Record<IneligibilityReason, string> = {
  date_missing: "No published date",
  date_invalid: "Invalid/epoch date (e.g. Jan 1970)",
  before_campaign_start: "Published before campaign start",
  unsupported_platform: "Unsupported platform",
  no_canonical_url: "No canonical URL",
};

/** Convert a YYYY-MM-DD ET calendar date to the UTC millisecond of ET midnight
 *  (DST-aware via the locale round-trip). Falls back to UTC midnight. */
export function etMidnightMs(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d) return NaN;
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  try {
    const inTz = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "America/New_York" }));
    const inUtc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" }));
    const offset = inTz.getTime() - inUtc.getTime(); // ET is behind UTC ⇒ negative
    return guess - offset;
  } catch {
    return guess;
  }
}

/** The campaign-start floor (ms) used by eligibility. */
export function campaignStartMs(): number {
  const ms = etMidnightMs(getCampaignStartDateEt());
  return Number.isNaN(ms) ? 0 : ms;
}

/** ISO of the campaign-start floor (for display/audit). */
export function campaignStartISO(): string {
  return new Date(campaignStartMs()).toISOString();
}

/** Bootcamp-campaign start floor (ms) — earlier than the MTL floor. */
export function bootcampStartMs(): number {
  const ms = etMidnightMs(getBootcampStartDateEt());
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Eligibility floor for a video given its CAMPAIGN assignment. Bootcamp-tagged
 * content is eligible back to the (earlier) Bootcamp start; everything else
 * (MTL, untagged-default-MTL, unassigned) uses the MTL start, so pre-MTL
 * profile-feed items never silently count as MTL. Pass the resolved campaign
 * slug (videoCampaign(v)) — null/"mtl" → MTL floor, "bootcamp" → Bootcamp floor.
 */
export function eligibilityFloorForCampaign(campaign: "mtl" | "bootcamp" | null): number {
  return campaign === "bootcamp" ? bootcampStartMs() : campaignStartMs();
}

// Accepts both a stored Video and a freshly-normalized item (whose originalUrl
// may be null) — the predicate treats a missing canonical URL as ineligible.
type EligibilityInput = {
  platform: Video["platform"];
  originalUrl: string | null;
  publishedAt: string | null;
  isSeed: boolean;
  episodeGroupId: string | null;
};

/**
 * Returns null when the video is eligible, otherwise the reason it is excluded.
 *
 * Rules (in order):
 *  1. Seeds (the original campaign URLs) are always eligible.
 *  2. A garbage/epoch publishedAt (the Jan-1970 signature) ALWAYS disqualifies —
 *     even an episode-assigned record — because such a date is never real.
 *  3. A record assigned to a real episode (not the unassigned bucket) is
 *     eligible (admin-curated), provided its date isn't garbage.
 *  4. Otherwise (unassigned, non-seed) it must fully qualify: a valid date on or
 *     after the campaign start, a supported platform, and a canonical URL.
 */
export function ineligibilityReason(
  v: EligibilityInput,
  startMs: number = campaignStartMs(),
  unassignedEpisodeId: string | null = null,
): IneligibilityReason | null {
  if (v.isSeed) return null;

  // Date parse + garbage guard.
  let t: number | null = null;
  if (v.publishedAt) {
    const parsed = Date.parse(v.publishedAt);
    if (Number.isNaN(parsed) || new Date(parsed).getUTCFullYear() < MIN_PLAUSIBLE_YEAR) {
      return "date_invalid";
    }
    t = parsed;
  }

  const assignedReal = Boolean(v.episodeGroupId) && v.episodeGroupId !== unassignedEpisodeId;
  if (assignedReal) return null; // admin-curated, non-garbage date (or no date)

  // Unassigned / non-seed must fully qualify.
  if (t === null) return "date_missing";
  if (t < startMs) return "before_campaign_start";
  if (!SUPPORTED_PLATFORMS.includes(v.platform)) return "unsupported_platform";
  if (!v.originalUrl) return "no_canonical_url";
  return null;
}

export function isCampaignEligible(
  v: EligibilityInput,
  startMs: number = campaignStartMs(),
  unassignedEpisodeId: string | null = null,
): boolean {
  return ineligibilityReason(v, startMs, unassignedEpisodeId) === null;
}

// ── Discovery: should a NEW (unmatched) profile-feed candidate be auto-added,
//    sent to the admin "Possible new content" review queue, or ignored? ───────

export type DiscoveryDecision =
  | { decision: "add" }
  | { decision: "review"; reason: string }
  | { decision: "ignore"; reason: IneligibilityReason | "no_stable_id" };

const DEFAULT_DISCOVERY_LOOKBACK_MS = 72 * 60 * 60 * 1000;

/**
 * Classify a brand-new (not-yet-tracked) candidate returned by a known campaign
 * profile endpoint:
 *  - ignore  → fails base eligibility (invalid/epoch date, before campaign start,
 *              unsupported platform, no canonical URL).
 *  - add     → eligible, has a stable id, AND published within the lookback
 *              window (recent → confidently this campaign's new post).
 *  - review  → eligible but uncertain (no stable id, or older than the lookback
 *              window) → admin "Possible new content", never auto-counted.
 * Dedup against already-tracked videos is the caller's job (only unmatched items
 * should reach here).
 */
export function classifyDiscoveryCandidate(
  v: {
    platform: Platform;
    originalUrl: string | null;
    externalVideoId: string | null;
    publishedAt: string | null;
  },
  opts: { startMs?: number; lookbackMs?: number; now?: number } = {},
): DiscoveryDecision {
  const startMs = opts.startMs ?? campaignStartMs();
  const lookbackMs = opts.lookbackMs ?? DEFAULT_DISCOVERY_LOOKBACK_MS;
  const now = opts.now ?? Date.now();

  const reason = ineligibilityReason(
    { platform: v.platform, originalUrl: v.originalUrl, publishedAt: v.publishedAt, isSeed: false, episodeGroupId: null },
    startMs,
    null,
  );
  if (reason) return { decision: "ignore", reason };

  // A stable platform id is required to dedupe a future auto-add reliably.
  if (!v.externalVideoId) return { decision: "review", reason: "no_stable_id" };

  const t = Date.parse(v.publishedAt as string); // valid — base eligibility passed
  if (t >= now - lookbackMs) return { decision: "add" };
  return { decision: "review", reason: "older_than_discovery_window" };
}

/** A persisted candidate awaiting admin approval (rawJson.discoveryReview flag).
 *  Excluded from every public total/list until an admin promotes it. */
export function isReviewCandidate(v: { rawJson?: unknown }): boolean {
  const raw = v.rawJson;
  return Boolean(
    raw && typeof raw === "object" && (raw as { discoveryReview?: unknown }).discoveryReview === true,
  );
}
