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

import { getCampaignStartDateEt } from "./config";
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
