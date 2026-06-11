// Apify-backed provider for TikTok / Instagram / Facebook / YouTube.
// One instance per platform; the actor ID comes from the runtime
// ProviderConfig (admin-set) or the APIFY_<PLATFORM>_ACTOR_ID env var.

import { getActorIdFromEnv, getApifyToken } from "../config";
import { normalizeCommentItem } from "../apify/normalize";
import type {
  NormalizedComment,
  NormalizedVideo,
  Platform,
  PlatformProfile,
  ProviderConfig,
  Video,
} from "../types";
import { runActor } from "../apify/client";
import { buildInputCandidates, MAX_INPUT_ATTEMPTS } from "../apify/input-builder";
import {
  detectCapabilities,
  extractEmbeddedComments,
  normalizeVideoItem,
} from "../apify/normalize";
import type {
  PlatformFetchResult,
  ProviderReadiness,
  SocialPlatformProvider,
} from "./types";

export class ApifyProvider implements SocialPlatformProvider {
  platform: Platform;
  providerType = "apify" as const;
  supportsComments: boolean;
  supportsDiscovery: boolean;
  supportsSavesOrBookmarks: boolean;
  private config: ProviderConfig | null;

  constructor(platform: Platform, config: ProviderConfig | null) {
    this.platform = platform;
    this.config = config;
    // TikTok (clockworks) always gets the comments path: comments arrive via a
    // side dataset (commentsDatasetUrl) that capability tests can under-detect.
    this.supportsComments = (config?.supportsComments ?? false) || platform === "tiktok";
    this.supportsDiscovery = config?.supportsDiscovery ?? true;
    this.supportsSavesOrBookmarks = platform === "tiktok";
  }

  actorId(): string | null {
    return this.config?.actorId?.trim() || getActorIdFromEnv(this.platform);
  }

  readiness(): ProviderReadiness {
    if (!getApifyToken()) {
      return {
        ready: false,
        status: "token_missing",
        sourceStatus: "needs_apify_token",
        detail: "Set APIFY_TOKEN in .env.local / Vercel env vars",
      };
    }
    if (!this.actorId()) {
      return {
        ready: false,
        status: "actor_missing",
        sourceStatus: "actor_not_configured",
        detail: "Apify token connected — assign an actor in /admin → Apify Setup",
      };
    }
    if (this.config?.status === "actor_test_failed") {
      return {
        ready: true, // still attempt refreshes; status surfaces the risk
        status: "actor_test_failed",
        sourceStatus: "refresh_failed",
        detail: "Last actor test failed — check /admin",
      };
    }
    return { ready: true, status: this.config?.status ?? "untested", sourceStatus: "live", detail: null };
  }

  private async run(
    kind: "videos" | "discover",
    ctx: {
      videoUrls?: string[];
      profileUrl?: string;
      sinceIso?: string;
      limit?: number;
    },
  ): Promise<Array<Record<string, unknown>>> {
    const actorId = this.actorId();
    if (!actorId) throw new Error(`No Apify actor configured for ${this.platform}`);
    const candidates = buildInputCandidates(this.platform, actorId, kind, {
      ...ctx,
      commentsPerPost: this.supportsComments ? 15 : undefined,
      override: this.config?.inputOverride ?? undefined,
    });
    if (candidates.length === 0) {
      throw new Error(`Could not build actor input for ${this.platform} (${kind})`);
    }
    let lastError: unknown = null;
    for (const candidate of candidates.slice(0, MAX_INPUT_ATTEMPTS)) {
      try {
        const result = await runActor({ actorId, input: candidate.input });
        if (result.items.length > 0) return result.items;
        lastError = new Error(`Actor returned 0 items (input: ${candidate.description})`);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async discoverNewVideos(profile: PlatformProfile, since: Date): Promise<NormalizedVideo[]> {
    const items = await this.run("discover", {
      profileUrl: profile.profileUrl,
      sinceIso: since.toISOString(),
      limit: 50,
    });
    return items
      .map((it) => normalizeVideoItem(it, this.platform))
      .filter((v): v is NormalizedVideo => v !== null)
      .filter((v) => !v.publishedAt || new Date(v.publishedAt) >= since);
  }

  async getVideoMetadata(url: string): Promise<NormalizedVideo | null> {
    const items = await this.run("videos", { videoUrls: [url] });
    for (const it of items) {
      const n = normalizeVideoItem(it, this.platform);
      if (n) return n;
    }
    return null;
  }

  async getVideoMetrics(video: Video): Promise<NormalizedVideo | null> {
    return this.getVideoMetadata(video.originalUrl);
  }

  async getVideoComments(video: Video): Promise<NormalizedComment[]> {
    if (!this.supportsComments) return [];
    const items = await this.run("videos", { videoUrls: [video.originalUrl] });
    const out: NormalizedComment[] = [];
    for (const it of items) out.push(...extractEmbeddedComments(it));
    return out;
  }

  /**
   * One actor run per platform per refresh: profile discovery (covering all
   * posts since the campaign start) doubles as the metrics fetch for every
   * tracked video the run returns. Seed videos missing from the discovery
   * result get a follow-up direct-URL run (when the actor supports URLs).
   */
  async fetchPlatform(
    profile: PlatformProfile | null,
    videos: Video[],
    since: Date,
  ): Promise<PlatformFetchResult> {
    const result: PlatformFetchResult = { videos: [], commentsByVideo: {} };
    let items: Array<Record<string, unknown>> = [];

    if (profile && this.supportsDiscovery) {
      // Ask the actor for a few days BEFORE the campaign start so seed videos
      // posted slightly earlier on this platform still come back in the sweep
      // (they update existing records; the refresh pipeline never inserts
      // pre-campaign videos as new).
      const margin = new Date(since.getTime() - 3 * 24 * 3600 * 1000);
      items = await this.run("discover", {
        profileUrl: profile.profileUrl,
        sinceIso: margin.toISOString(),
        limit: 50,
      });
    }

    const seen = new Set<string>();
    const commentFetches: Array<Promise<void>> = [];
    const ingest = (raw: Record<string, unknown>) => {
      const n = normalizeVideoItem(raw, this.platform);
      if (!n) return;
      const key = n.externalVideoId ?? n.originalUrl ?? JSON.stringify(raw).slice(0, 80);
      if (seen.has(key)) return;
      seen.add(key);
      result.videos.push(n);
      const embedded = extractEmbeddedComments(raw);
      if (embedded.length > 0) {
        result.commentsByVideo[key] = embedded;
      } else if (typeof raw.commentsDatasetUrl === "string" && this.supportsComments) {
        // Some actors (clockworks TikTok) deliver comments in a side dataset.
        // The dataset is shared across all videos in the run, so filter items
        // back to this video via their linkage fields (videoWebUrl etc.).
        commentFetches.push(
          fetchCommentsDataset(raw.commentsDatasetUrl, n.externalVideoId, n.originalUrl).then(
            (comments) => {
              if (comments.length > 0) result.commentsByVideo[key] = comments;
            },
          ),
        );
      }
    };
    items.forEach(ingest);
    await Promise.allSettled(commentFetches);

    // Direct-URL follow-up for tracked videos the profile sweep didn't return
    // (e.g. pinned exclusions, videos older than the date filter).
    const missing = videos.filter((v) => {
      const byId = v.externalVideoId && seen.has(v.externalVideoId);
      const byUrl = seen.has(v.originalUrl);
      return !byId && !byUrl;
    });
    // YouTube shorts actor is channel-only; skip URL follow-up there.
    if (missing.length > 0 && this.platform !== "youtube") {
      try {
        const extra = await this.run("videos", {
          videoUrls: missing.map((v) => v.originalUrl),
        });
        extra.forEach(ingest);
      } catch {
        // Leave the missing videos un-updated; their lastRefreshedAt stays old
        // and the UI shows the staleness honestly.
      }
    }

    return result;
  }

  /** Used by the admin actor-test flow to report detected capabilities. */
  detectFrom(items: Array<Record<string, unknown>>) {
    return detectCapabilities(items, this.platform);
  }
}

/** Comment-item fields that link a comment back to its video. */
const COMMENT_LINK_FIELDS = ["videoWebUrl", "postUrl", "videoUrl", "awemeId", "videoId", "postId", "inputUrl"];

/**
 * Fetch a comments side dataset (clockworks-style commentsDatasetUrl) and keep
 * only the comments belonging to the given video. Items with no linkage field
 * pass through (per-video datasets don't need filtering).
 */
async function fetchCommentsDataset(
  url: string,
  externalVideoId: string | null,
  originalUrl: string | null,
  limit = 100,
): Promise<NormalizedComment[]> {
  const token = getApifyToken();
  if (!token || !url.startsWith("https://api.apify.com/")) return [];
  try {
    const u = new URL(url);
    u.searchParams.set("clean", "true");
    u.searchParams.set("limit", String(limit));
    const res = await fetch(u.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const items = (await res.json()) as Array<Record<string, unknown>>;
    return items
      .filter((item) => {
        const links = COMMENT_LINK_FIELDS.map((f) => item[f]).filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
        if (links.length === 0) return true;
        return links.some(
          (link) =>
            (externalVideoId && link.includes(externalVideoId)) ||
            (originalUrl && (link === originalUrl || originalUrl.includes(link))),
        );
      })
      .map(normalizeCommentItem)
      .filter((c): c is NormalizedComment => c !== null);
  } catch {
    return [];
  }
}
