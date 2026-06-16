// Central env access + campaign seed constants. Secrets are read lazily and
// only ever on the server — nothing here is safe to import into client
// components except the obvious public constants.

import type { Platform } from "./types";

export const APP_NAME =
  process.env.NEXT_PUBLIC_APP_NAME || "Wachter Creator Campaign Dashboard";

export function getApifyToken(): string | null {
  const t = process.env.APIFY_TOKEN?.trim();
  return t ? t : null;
}

export function getYouTubeApiKey(): string | null {
  const k = process.env.YOUTUBE_API_KEY?.trim();
  return k ? k : null;
}

export function getAdminPassword(): string | null {
  const p = process.env.ADMIN_PASSWORD?.trim();
  return p ? p : null;
}

export function getCronSecret(): string | null {
  const s = process.env.CRON_SECRET?.trim();
  return s ? s : null;
}

export function isMockMode(): boolean {
  return process.env.MOCK_DATA === "1" || process.env.MOCK_DATA === "true";
}

// ---------------------------------------------------------------------------
// SocialCrawl — primary metrics provider for TikTok/Instagram/Facebook when
// enabled. Server-side only; the key is never exposed to the client and never
// printed. YouTube always stays on the official YouTube Data API.
// ---------------------------------------------------------------------------

export function getSocialcrawlKey(): string | null {
  const k = process.env.SOCIALCRAWL_API_KEY?.trim();
  return k ? k : null;
}

/** Master switch + key presence. SocialCrawl is only "on" when both hold. */
export function isSocialcrawlEnabled(): boolean {
  const v = process.env.SOCIALCRAWL_METRICS_ENABLED;
  const enabled = v === "1" || v?.toLowerCase() === "true";
  return enabled && getSocialcrawlKey() !== null;
}

/**
 * Which provider serves a non-YouTube platform's metrics. SocialCrawl only
 * when it's enabled AND selected for that platform; otherwise Apify (the
 * fallback / legacy default). YouTube is never routed here.
 */
export function metricsProviderFor(platform: Platform): "socialcrawl" | "apify" {
  if (platform === "youtube") return "apify"; // n/a — YouTube uses the Data API
  if (!isSocialcrawlEnabled()) return "apify";
  const general = (process.env.NON_YOUTUBE_METRICS_PROVIDER ?? "apify").trim().toLowerCase();
  if (platform === "facebook") {
    const fb = (process.env.FACEBOOK_METRICS_PROVIDER ?? general).trim().toLowerCase();
    return fb === "socialcrawl" ? "socialcrawl" : general === "socialcrawl" ? "socialcrawl" : "apify";
  }
  return general === "socialcrawl" ? "socialcrawl" : "apify";
}

/** Daily SocialCrawl credit cap — scheduled refreshes stop when reached. */
export function getSocialcrawlDailyCreditCap(): number {
  const n = Number(process.env.SOCIALCRAWL_DAILY_CREDIT_CAP);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/**
 * Instagram share-count add-on. The apify/instagram-reel-scraper fetches a
 * share count only when `includeSharesCount` is set, which adds per-reel work.
 * Stored data showed shares always null, so this is OFF by default (cost
 * control) — set ENABLE_INSTAGRAM_SHARES=1 to re-enable if it proves useful.
 */
export function shouldIncludeInstagramShares(): boolean {
  const v = process.env.ENABLE_INSTAGRAM_SHARES;
  return v === "1" || v?.toLowerCase() === "true";
}

const ACTOR_ENV_KEYS: Record<Platform, string> = {
  tiktok: "APIFY_TIKTOK_ACTOR_ID",
  instagram: "APIFY_INSTAGRAM_ACTOR_ID",
  facebook: "APIFY_FACEBOOK_ACTOR_ID",
  youtube: "APIFY_YOUTUBE_ACTOR_ID",
};

export function getActorIdFromEnv(platform: Platform): string | null {
  const v = process.env[ACTOR_ENV_KEYS[platform]]?.trim();
  return v ? v : null;
}

const BACKUP_ACTOR_ENV_KEYS: Record<Platform, string> = {
  tiktok: "APIFY_TIKTOK_BACKUP_ACTOR_ID",
  instagram: "APIFY_INSTAGRAM_BACKUP_ACTOR_ID",
  facebook: "APIFY_FACEBOOK_BACKUP_ACTOR_ID",
  youtube: "APIFY_YOUTUBE_BACKUP_ACTOR_ID",
};

export function getBackupActorIdFromEnv(platform: Platform): string | null {
  const v = process.env[BACKUP_ACTOR_ENV_KEYS[platform]]?.trim();
  return v ? v : null;
}

export function actorEnvKey(platform: Platform): string {
  return ACTOR_ENV_KEYS[platform];
}

/**
 * Campaign start floor (ET calendar date, YYYY-MM-DD). Content published before
 * this — and any record with an invalid/epoch date — is excluded from active
 * campaign totals (see src/lib/eligibility.ts). Defaults to 2026-06-08 (the ET
 * day the campaign launched; the earliest legit post is 2026-06-09). Adjust via
 * the CAMPAIGN_START_DATE_ET env var without a code change.
 */
export function getCampaignStartDateEt(): string {
  const raw = process.env.CAMPAIGN_START_DATE_ET?.trim();
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "2026-06-08";
}

// ---------------------------------------------------------------------------
// Campaign seed data (URLs provided at campaign kickoff)
// ---------------------------------------------------------------------------

export const SEED_CAMPAIGN = {
  name: "Cybernick0x x Wachter Campaign",
  creatorName: "Cybernick0x",
  company: "Wachter",
} as const;

export const SEED_VIDEOS: Array<{ platform: Platform; url: string }> = [
  { platform: "tiktok", url: "https://www.tiktok.com/@cybernick0x/video/7649233656807968014" },
  { platform: "youtube", url: "https://www.youtube.com/shorts/CL62fTyvMOY" },
  { platform: "facebook", url: "https://www.facebook.com/reel/1268008372073152" },
  { platform: "instagram", url: "https://www.instagram.com/cybernick0x/reel/DZWaZjlggrV/" },
];

export const SEED_PROFILES: Array<{ platform: Platform; url: string }> = [
  { platform: "tiktok", url: "https://www.tiktok.com/@cybernick0x" },
  { platform: "youtube", url: "https://www.youtube.com/@cybernick0x/shorts" },
  {
    platform: "facebook",
    url: "https://www.facebook.com/people/Cybernick0x/61585540862384/?sk=reels_tab",
  },
  { platform: "instagram", url: "https://www.instagram.com/cybernick0x" },
];

export const DEFAULT_EPISODE_GROUPS = [
  "Bootcamp",
  "Mount Laurel interviews",
  "Low voltage career",
  "Tools and tech",
  "Technician training",
  "Wachter culture",
  "Other / unassigned",
] as const;

/**
 * Candidate Apify actors supplied at project kickoff, identified via the
 * Apify API. Shown in /admin → Apify Setup as starting points; nothing is
 * "active" until tested and assigned.
 */
export const CANDIDATE_ACTORS: Array<{
  actorId: string;
  name: string;
  platform: Platform;
  note: string;
}> = [
  {
    actorId: "GdWCkxBtKWOsKjdch",
    name: "clockworks/tiktok-scraper",
    platform: "tiktok",
    note: "Full TikTok scraper — post URLs, profiles, comments. Recommended for TikTok.",
  },
  {
    actorId: "OtzYfK1ndEGdwWFKQ",
    name: "clockworks/free-tiktok-scraper",
    platform: "tiktok",
    note: "Lighter TikTok data extractor (no per-post comments options). Alternate.",
  },
  {
    actorId: "xMc5Ga1oCONPmWJIa",
    name: "apify/instagram-reel-scraper",
    platform: "instagram",
    note: "Official Apify Instagram Reel scraper. Recommended for Instagram.",
  },
  {
    actorId: "PE8EVAh0QG4mH6cLP",
    name: "hpix/ig-reels-scraper",
    platform: "instagram",
    note: "Alternate Instagram Reels scraper.",
  },
  {
    actorId: "KoJrdxJCTtpon81KY",
    name: "apify/facebook-posts-scraper",
    platform: "facebook",
    note: "Official Apify Facebook posts scraper (pages/profiles, reels included).",
  },
  {
    actorId: "WT1BVWatl2aHVeFEH",
    name: "streamers/youtube-shorts-scraper",
    platform: "youtube",
    note: "YouTube Shorts channel scraper. Used when no YOUTUBE_API_KEY is set.",
  },
];
