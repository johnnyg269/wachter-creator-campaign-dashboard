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
