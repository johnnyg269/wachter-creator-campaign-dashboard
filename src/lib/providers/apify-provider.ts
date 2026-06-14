// Apify-backed provider for TikTok / Instagram / Facebook / YouTube.
// One instance per platform; the actor ID comes from the runtime
// ProviderConfig (admin-set) or the APIFY_<PLATFORM>_ACTOR_ID env var.

import { getActorIdFromEnv, getApifyToken, getBackupActorIdFromEnv } from "../config";
import { mergeNormalizedVideos, metricCompleteness, normalizeCommentItem } from "../apify/normalize";
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
  AttemptDraft,
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

  backupActorId(): string | null {
    return this.config?.backupActorId?.trim() || getBackupActorIdFromEnv(this.platform);
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

  /**
   * Run the actor, trying each input-format candidate (bounded), recording an
   * AttemptDraft per try into `attempts` when provided.
   */
  private async runWithMeta(
    kind: "videos" | "discover",
    ctx: {
      videoUrls?: string[];
      profileUrl?: string;
      sinceIso?: string;
      limit?: number;
      knownVideoUrls?: string[];
    },
    opts: { actorId?: string; attemptKind?: string; attempts?: AttemptDraft[] } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const actorId = opts.actorId ?? this.actorId();
    if (!actorId) throw new Error(`No Apify actor configured for ${this.platform}`);
    const candidates = buildInputCandidates(this.platform, actorId, kind, {
      ...ctx,
      commentsPerPost: this.supportsComments ? 15 : undefined,
      // The admin input override applies to the primary actor only.
      override: opts.actorId ? undefined : (this.config?.inputOverride ?? undefined),
    });
    if (candidates.length === 0) {
      throw new Error(`Could not build actor input for ${this.platform} (${kind})`);
    }
    const record = (a: Omit<AttemptDraft, "provider" | "actorId" | "kind">) =>
      opts.attempts?.push({
        provider: "apify",
        actorId,
        kind: opts.attemptKind ?? kind,
        ...a,
      });
    let lastError: unknown = null;
    for (const candidate of candidates.slice(0, MAX_INPUT_ATTEMPTS)) {
      try {
        const result = await runActor({ actorId, input: candidate.input });
        record({
          inputDescription: candidate.description,
          success: result.items.length > 0,
          runId: result.runId,
          itemCount: result.items.length,
          error: result.items.length === 0 ? "Actor returned 0 items" : null,
        });
        if (result.items.length > 0) return result.items;
        lastError = new Error(`Actor returned 0 items (input: ${candidate.description})`);
      } catch (e) {
        record({
          inputDescription: candidate.description,
          success: false,
          runId: null,
          itemCount: 0,
          error: e instanceof Error ? e.message.slice(0, 300) : String(e),
        });
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private run(
    kind: "videos" | "discover",
    ctx: { videoUrls?: string[]; profileUrl?: string; sinceIso?: string; limit?: number },
  ): Promise<Array<Record<string, unknown>>> {
    return this.runWithMeta(kind, ctx);
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
    const result: PlatformFetchResult = { videos: [], commentsByVideo: {}, attempts: [] };
    let items: Array<Record<string, unknown>> = [];

    if (profile && this.supportsDiscovery) {
      // Ask the actor for a few days BEFORE the campaign start so seed videos
      // posted slightly earlier on this platform still come back in the sweep
      // (they update existing records; the refresh pipeline never inserts
      // pre-campaign videos as new).
      const margin = new Date(since.getTime() - 3 * 24 * 3600 * 1000);
      try {
        items = await this.runWithMeta(
          "discover",
          {
            profileUrl: profile.profileUrl,
            sinceIso: margin.toISOString(),
            limit: 50,
            // Instagram: ride direct reel URLs along with discovery — the
            // reel-page surface is fresher than the profile feed (verified
            // live in Phase 3.3c) and costs no extra actor run.
            knownVideoUrls:
              this.platform === "instagram"
                ? videos.slice(0, 12).map((v) => v.originalUrl)
                : undefined,
          },
          { attempts: result.attempts },
        );
      } catch {
        // The profile-discovery surface returned nothing / errored this cycle.
        // Facebook in particular alternates between a feed surface and a
        // reel-page surface, and an empty discovery used to throw the WHOLE
        // platform — marking every video failed and blanking the dashboard
        // card every other refresh. The attempt is already recorded; fall
        // through to the per-video URL follow-up below so tracked videos still
        // refresh from their own URLs and last-known-good data is never wiped.
      }
    }

    // Different surfaces of the same platform return the same video under
    // different shapes (Facebook: feed item exposes views, reel page doesn't).
    // Ingest MERGES same-video entries instead of dropping later ones — the
    // record with the most metric fields becomes the merge base.
    const entryIndex = new Map<string, number>();
    const keysOf = (n: NormalizedVideo): string[] =>
      [n.externalVideoId, n.originalUrl].filter((k): k is string => Boolean(k));
    const commentFetches: Array<Promise<void>> = [];
    const ingest = (raw: Record<string, unknown>) => {
      const n = normalizeVideoItem(raw, this.platform);
      if (!n) return;
      const keys = keysOf(n);
      if (keys.length === 0) return;
      const existingIdx = keys.map((k) => entryIndex.get(k)).find((i) => i !== undefined);
      let finalIdx: number;
      if (existingIdx !== undefined) {
        const current = result.videos[existingIdx];
        result.videos[existingIdx] =
          metricCompleteness(n) > metricCompleteness(current)
            ? mergeNormalizedVideos(n, current)
            : mergeNormalizedVideos(current, n);
        finalIdx = existingIdx;
      } else {
        result.videos.push(n);
        finalIdx = result.videos.length - 1;
      }
      for (const k of [...keys, ...keysOf(result.videos[finalIdx])]) entryIndex.set(k, finalIdx);

      const commentKey = result.videos[finalIdx].externalVideoId ?? result.videos[finalIdx].originalUrl ?? keys[0];
      const embedded = extractEmbeddedComments(raw);
      if (embedded.length > 0) {
        result.commentsByVideo[commentKey] = [
          ...(result.commentsByVideo[commentKey] ?? []),
          ...embedded,
        ];
      } else if (typeof raw.commentsDatasetUrl === "string" && this.supportsComments) {
        // Some actors (clockworks TikTok) deliver comments in a side dataset.
        // The dataset is shared across all videos in the run, so filter items
        // back to this video via their linkage fields (videoWebUrl etc.).
        commentFetches.push(
          fetchCommentsDataset(raw.commentsDatasetUrl, n.externalVideoId, n.originalUrl).then(
            (comments) => {
              if (comments.length > 0) result.commentsByVideo[commentKey] = comments;
            },
          ),
        );
      }
    };
    items.forEach(ingest);
    await Promise.allSettled(commentFetches);

    const matchesTracked = (v: Video): boolean =>
      Boolean(
        (v.externalVideoId && entryIndex.has(v.externalVideoId)) || entryIndex.has(v.originalUrl),
      );

    // Direct-URL follow-up for tracked videos the profile sweep didn't return
    // (pinned exclusions, date-filter misses) — or returned WITHOUT a view
    // count (profile feeds sometimes hand back stub items; the direct reel
    // page is the fresher, more complete surface).
    const entryViewsNull = (v: Video): boolean => {
      const idx = entryIndex.get(v.externalVideoId ?? "") ?? entryIndex.get(v.originalUrl);
      return idx !== undefined && result.videos[idx].views === null;
    };
    const missing = videos.filter((v) => !matchesTracked(v) || entryViewsNull(v));
    // YouTube shorts actor is channel-only; skip URL follow-up there.
    if (missing.length > 0 && this.platform !== "youtube") {
      try {
        const extra = await this.runWithMeta(
          "videos",
          { videoUrls: missing.map((v) => v.originalUrl) },
          { attempts: result.attempts },
        );
        extra.forEach(ingest);
      } catch {
        // Attempt already recorded; the missing videos stay un-updated and the
        // UI shows the staleness honestly.
      }
    }

    // Backup actor pass: only when the primary left key gaps (a tracked video
    // entirely missing, or returned without a view count).
    const backupId = this.backupActorId();
    if (backupId) {
      const gaps = videos.filter((v) => {
        if (!matchesTracked(v)) return true;
        const idx = entryIndex.get(v.externalVideoId ?? "") ?? entryIndex.get(v.originalUrl);
        return idx !== undefined && result.videos[idx].views === null;
      });
      if (gaps.length > 0) {
        try {
          const extra = await this.runWithMeta(
            "videos",
            { videoUrls: gaps.map((v) => v.originalUrl) },
            { actorId: backupId, attemptKind: "backup", attempts: result.attempts },
          );
          extra.forEach(ingest); // merge fills only the missing fields
        } catch {
          // Recorded in attempts; unavailable only after every source failed.
        }
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
