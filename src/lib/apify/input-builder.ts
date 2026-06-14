// Builds actor input payloads. Known actors (the candidates verified for this
// campaign) get exact input shapes pulled from their published input schemas;
// unknown actors get an ordered list of common patterns to try — capped so we
// never hammer Apify with retries.

import type { Platform } from "../types";
import { parseProfileUrl } from "../url-parse";

export type FetchKind = "videos" | "discover";

export interface BuiltInput {
  input: Record<string, unknown>;
  /** Human-readable description shown in admin test output. */
  description: string;
}

export interface InputContext {
  /** Direct video URLs to fetch (kind="videos"). */
  videoUrls?: string[];
  /** Profile URL to discover from (kind="discover"). */
  profileUrl?: string;
  /**
   * Already-tracked video URLs to include alongside discovery, for actors
   * whose input accepts both (Instagram): the direct-URL surface returns
   * fresher per-video metrics than the profile feed, at no extra run cost.
   */
  knownVideoUrls?: string[];
  /** Only return posts published at/after this ISO date (when supported). */
  sinceIso?: string;
  /** Max results for discovery runs. */
  limit?: number;
  /** Comments per post (when the actor supports it). */
  commentsPerPost?: number;
  /** Instagram: request the (extra-cost) share count add-on. Default off. */
  includeShares?: boolean;
  /** Admin-provided full input override — used verbatim when present. */
  override?: unknown;
}

function isoDateOnly(iso: string | undefined): string | undefined {
  return iso ? iso.slice(0, 10) : undefined;
}

/** Known actor IDs → exact input builders (schemas verified via Apify API). */
const KNOWN_ACTORS: Record<
  string,
  (kind: FetchKind, ctx: InputContext) => BuiltInput | null
> = {
  // clockworks/tiktok-scraper
  GdWCkxBtKWOsKjdch: clockworksTikTok,
  // clockworks/free-tiktok-scraper (same input family, no comment options)
  OtzYfK1ndEGdwWFKQ: (kind, ctx) => {
    const built = clockworksTikTok(kind, ctx);
    if (built) delete built.input.commentsPerPost;
    return built;
  },
  // apify/instagram-reel-scraper — `username` array accepts profile or reel URLs
  xMc5Ga1oCONPmWJIa: (kind, ctx) => {
    const targets =
      kind === "videos"
        ? (ctx.videoUrls ?? [])
        : [
            ...(ctx.profileUrl ? [ctx.profileUrl] : []),
            // Direct reel URLs piggyback on the discovery run — the reel-page
            // surface returns fresher play counts than the profile feed.
            ...(ctx.knownVideoUrls ?? []),
          ];
    if (targets.length === 0) return null;
    const input: Record<string, unknown> = {
      username: targets,
      resultsLimit: kind === "videos" ? targets.length : (ctx.limit ?? 30),
      // Share-count add-on is opt-in (cost control) — stored data showed it
      // always returned null, so it is off unless ENABLE_INSTAGRAM_SHARES=1.
      ...(ctx.includeShares ? { includeSharesCount: true } : {}),
    };
    if (kind === "discover" && ctx.sinceIso) {
      input.onlyPostsNewerThan = isoDateOnly(ctx.sinceIso);
    }
    return {
      input,
      description: `instagram-reel-scraper: username=[${targets.length} url(s)]`,
    };
  },
  // hpix/ig-reels-scraper — requires `target` + `reels_count`
  PE8EVAh0QG4mH6cLP: (kind, ctx) => {
    if (kind === "videos" && ctx.videoUrls?.length) {
      return {
        input: {
          target: "post_urls",
          post_urls: ctx.videoUrls,
          reels_count: ctx.videoUrls.length,
        },
        description: "ig-reels-scraper: target=post_urls",
      };
    }
    if (kind === "discover" && ctx.profileUrl) {
      const handle = parseProfileUrl(ctx.profileUrl)?.handle ?? ctx.profileUrl;
      return {
        input: {
          target: "profiles",
          profiles: [handle],
          reels_count: ctx.limit ?? 30,
          ...(ctx.sinceIso ? { beginDate: isoDateOnly(ctx.sinceIso) } : {}),
        },
        description: `ig-reels-scraper: target=profiles [${handle}]`,
      };
    }
    return null;
  },
  // apify/facebook-posts-scraper — startUrls works for pages and single reels
  KoJrdxJCTtpon81KY: (kind, ctx) => {
    const urls =
      kind === "videos" ? (ctx.videoUrls ?? []) : ctx.profileUrl ? [ctx.profileUrl] : [];
    if (urls.length === 0) return null;
    const input: Record<string, unknown> = {
      startUrls: urls.map((url) => ({ url })),
      resultsLimit: kind === "videos" ? urls.length : (ctx.limit ?? 30),
    };
    if (kind === "discover" && ctx.sinceIso) {
      input.onlyPostsNewerThan = isoDateOnly(ctx.sinceIso);
    }
    return {
      input,
      description: `facebook-posts-scraper: startUrls=[${urls.length} url(s)]`,
    };
  },
  // streamers/youtube-shorts-scraper — channel-based only
  WT1BVWatl2aHVeFEH: (kind, ctx) => {
    // This actor scrapes channels; for direct video URLs we scrape the channel
    // and match IDs afterwards. A channel/profile URL is required either way.
    const channel = ctx.profileUrl;
    if (!channel) return null;
    return {
      input: {
        channels: [channel],
        maxResultsShorts: ctx.limit ?? 30,
        sortChannelShortsBy: "NEWEST",
        ...(ctx.sinceIso ? { oldestPostDate: isoDateOnly(ctx.sinceIso) } : {}),
      },
      description: `youtube-shorts-scraper: channels=[${channel}]`,
    };
  },
};

function clockworksTikTok(kind: FetchKind, ctx: InputContext): BuiltInput | null {
  if (kind === "videos" && ctx.videoUrls?.length) {
    return {
      input: {
        postURLs: ctx.videoUrls,
        resultsPerPage: ctx.videoUrls.length,
        ...(ctx.commentsPerPost ? { commentsPerPost: ctx.commentsPerPost } : {}),
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      },
      description: `tiktok-scraper: postURLs=[${ctx.videoUrls.length} url(s)]`,
    };
  }
  if (kind === "discover" && ctx.profileUrl) {
    const handle = parseProfileUrl(ctx.profileUrl)?.handle ?? ctx.profileUrl;
    return {
      input: {
        profiles: [handle],
        profileScrapeSections: ["videos"],
        profileSorting: "latest",
        resultsPerPage: ctx.limit ?? 30,
        ...(ctx.sinceIso ? { oldestPostDateUnified: isoDateOnly(ctx.sinceIso) } : {}),
        ...(ctx.commentsPerPost ? { commentsPerPost: ctx.commentsPerPost } : {}),
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
      },
      description: `tiktok-scraper: profiles=[${handle}]`,
    };
  }
  return null;
}

/**
 * Generic input patterns for unknown actors, in order of how common they are
 * across Apify Store scrapers. The test runner tries at most the first three.
 */
export function genericInputCandidates(kind: FetchKind, ctx: InputContext): BuiltInput[] {
  const urls =
    kind === "videos" ? (ctx.videoUrls ?? []) : ctx.profileUrl ? [ctx.profileUrl] : [];
  if (urls.length === 0) return [];
  return [
    {
      input: { startUrls: urls.map((url) => ({ url })) },
      description: `{ startUrls: [{ url }] }`,
    },
    { input: { startUrls: urls }, description: `{ startUrls: ["..."] }` },
    { input: { directUrls: urls }, description: `{ directUrls: ["..."] }` },
    { input: { urls }, description: `{ urls: ["..."] }` },
    { input: { url: urls[0] }, description: `{ url: "..." }` },
    { input: { videoUrls: urls }, description: `{ videoUrls: ["..."] }` },
    { input: { postUrls: urls }, description: `{ postUrls: ["..."] }` },
  ];
}

/**
 * Returns the ordered input candidates for an actor. Known actors return one
 * exact input; unknown actors return generic patterns (callers must cap
 * attempts). An admin `override` always wins and is used verbatim.
 */
export function buildInputCandidates(
  _platform: Platform,
  actorId: string,
  kind: FetchKind,
  ctx: InputContext,
): BuiltInput[] {
  if (ctx.override && typeof ctx.override === "object") {
    return [
      {
        input: ctx.override as Record<string, unknown>,
        description: "admin input override (used verbatim)",
      },
    ];
  }
  const known = KNOWN_ACTORS[actorId];
  if (known) {
    const built = known(kind, ctx);
    return built ? [built] : [];
  }
  return genericInputCandidates(kind, ctx);
}

/** Max input formats to attempt against an unknown actor in one test. */
export const MAX_INPUT_ATTEMPTS = 3;
