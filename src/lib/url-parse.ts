// Platform URL parsing — pure functions, unit-tested in tests/url-parse.test.ts.

import type { Platform } from "./types";

export interface ParsedVideoUrl {
  platform: Platform;
  externalVideoId: string | null;
  /** Creator handle when present in the URL (no @ prefix). */
  handle: string | null;
  canonicalUrl: string;
}

export interface ParsedProfileUrl {
  platform: Platform;
  handle: string | null;
  externalProfileId: string | null;
}

export function detectPlatform(url: string): Platform | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host.endsWith("tiktok.com")) return "tiktok";
  if (host.endsWith("youtube.com") || host === "youtu.be") return "youtube";
  if (host.endsWith("instagram.com")) return "instagram";
  if (host.endsWith("facebook.com") || host.endsWith("fb.watch")) return "facebook";
  return null;
}

export function parseVideoUrl(url: string): ParsedVideoUrl | null {
  const platform = detectPlatform(url);
  if (!platform) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname;

  if (platform === "tiktok") {
    const m = path.match(/@([\w.-]+)\/video\/(\d+)/);
    if (m) {
      return {
        platform,
        handle: m[1],
        externalVideoId: m[2],
        canonicalUrl: `https://www.tiktok.com/@${m[1]}/video/${m[2]}`,
      };
    }
    return { platform, handle: null, externalVideoId: null, canonicalUrl: url };
  }

  if (platform === "youtube") {
    let id: string | null = null;
    const shorts = path.match(/\/shorts\/([A-Za-z0-9_-]{5,})/);
    if (shorts) id = shorts[1];
    if (!id && u.hostname === "youtu.be") {
      const seg = path.split("/").filter(Boolean)[0];
      if (seg) id = seg;
    }
    if (!id) id = u.searchParams.get("v");
    return {
      platform,
      handle: null,
      externalVideoId: id,
      canonicalUrl: id ? `https://www.youtube.com/shorts/${id}` : url,
    };
  }

  if (platform === "instagram") {
    // /reel/<code>/, /reels/<code>/, /<handle>/reel/<code>/, /p/<code>/
    const m = path.match(/\/(?:reels?|p)\/([A-Za-z0-9_-]+)/);
    const handleMatch = path.match(/^\/([\w.]+)\/reels?\//);
    if (m) {
      return {
        platform,
        handle: handleMatch ? handleMatch[1] : null,
        externalVideoId: m[1],
        canonicalUrl: `https://www.instagram.com/reel/${m[1]}/`,
      };
    }
    return { platform, handle: null, externalVideoId: null, canonicalUrl: url };
  }

  // facebook
  const reel = path.match(/\/reel\/(\d+)/);
  if (reel) {
    return {
      platform,
      handle: null,
      externalVideoId: reel[1],
      canonicalUrl: `https://www.facebook.com/reel/${reel[1]}`,
    };
  }
  const watch = u.searchParams.get("v");
  if (watch && /^\d+$/.test(watch)) {
    return { platform, handle: null, externalVideoId: watch, canonicalUrl: url };
  }
  // Share links: facebook.com/share/r/<slug>/ (reels) or /share/v/<slug>/
  const share = path.match(/\/share\/[rv]\/([\w-]+)/);
  if (share) {
    return { platform, handle: null, externalVideoId: share[1], canonicalUrl: url };
  }
  const videosPath = path.match(/\/videos\/(\d+)/);
  if (videosPath) {
    return { platform, handle: null, externalVideoId: videosPath[1], canonicalUrl: url };
  }
  return { platform, handle: null, externalVideoId: null, canonicalUrl: url };
}

export function parseProfileUrl(url: string): ParsedProfileUrl | null {
  const platform = detectPlatform(url);
  if (!platform) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const path = u.pathname;

  if (platform === "tiktok") {
    const m = path.match(/^\/@([\w.-]+)/);
    return { platform, handle: m ? m[1] : null, externalProfileId: null };
  }
  if (platform === "youtube") {
    const m = path.match(/^\/@([\w.-]+)/);
    const channel = path.match(/^\/channel\/(UC[\w-]+)/);
    return {
      platform,
      handle: m ? m[1] : null,
      externalProfileId: channel ? channel[1] : null,
    };
  }
  if (platform === "instagram") {
    const m = path.match(/^\/([\w.]+)\/?$/);
    return { platform, handle: m ? m[1] : null, externalProfileId: null };
  }
  // facebook: /people/<Name>/<numericId>/ or /<vanity>
  const people = path.match(/^\/people\/([^/]+)\/(\d+)/);
  if (people) {
    return { platform, handle: decodeURIComponent(people[1]), externalProfileId: people[2] };
  }
  const vanity = path.match(/^\/([\w.]+)\/?$/);
  return { platform, handle: vanity ? vanity[1] : null, externalProfileId: null };
}

/**
 * TikTok video IDs are snowflakes — the top 32 bits are the unix publish
 * timestamp. Lets us show publish time even before metadata is fetched.
 */
export function tiktokPublishedAtFromId(id: string): string | null {
  if (!/^\d{15,}$/.test(id)) return null;
  try {
    const seconds = Number(BigInt(id) >> 32n);
    if (seconds < 1_400_000_000 || seconds > 4_000_000_000) return null;
    return new Date(seconds * 1000).toISOString();
  } catch {
    return null;
  }
}
