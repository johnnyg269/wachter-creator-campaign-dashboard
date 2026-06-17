// SocialCrawl provider — primary metrics source for TikTok / Instagram /
// Facebook when enabled (YouTube always stays on the official Data API).
//
// One unified schema across platforms. Crucially, SocialCrawl's Facebook
// `engagement.views` is the PUBLIC Reel plays count — the number Apify's
// facebook-posts-scraper does not expose (it returns a stricter, lower
// `viewsCount`). The benchmark (docs/socialcrawl-benchmark.md) proved parity
// on TikTok/Instagram and the Facebook plays fix.
//
// Server-side only. The key is read lazily from env and NEVER logged (it is
// sent only in the x-api-key header, never in a URL).

import { getSocialcrawlKey } from "../config";
import { parseTimestamp } from "../apify/normalize";
import type { NormalizedComment, NormalizedVideo, Platform, PlatformProfile, Video } from "../types";
import { parseVideoUrl } from "../url-parse";
import type {
  AttemptDraft,
  PlatformFetchOptions,
  PlatformFetchResult,
  ProviderReadiness,
  SocialPlatformProvider,
} from "./types";

const BASE = "https://www.socialcrawl.dev/v1";

interface ScPost {
  id?: string;
  url?: string;
  permalink?: string;
  content?: {
    text?: string;
    // Thumbnail/cover fields vary by platform/endpoint; pickThumbnail() tries
    // them in order. media_urls is the VIDEO file — never a thumbnail.
    thumbnail_url?: string;
    thumbnailUrl?: string;
    cover?: string;
    cover_url?: string;
    coverUrl?: string;
    image?: string;
    image_url?: string;
    media_urls?: string | string[];
  };
  cover?: string;
  cover_url?: string;
  coverUrl?: string;
  image?: string;
  image_url?: string;
  video?: { cover?: string; cover_url?: string; coverUrl?: string; dynamic_cover?: string };
  engagement?: { views?: number; likes?: number; comments?: number; shares?: number; saves?: number };
  // SocialCrawl sends published_at as a Unix-SECONDS NUMBER (e.g. 1781569866),
  // and created_at is typically absent — hence `string | number`. The raw value
  // MUST go through parseTimestamp (never straight into new Date(), which would
  // read seconds as ms and yield "Jan 1970"). Other date keys are accepted
  // defensively in case the schema varies.
  published_at?: string | number;
  publishedAt?: string | number;
  created_at?: string | number;
  createdAt?: string | number;
  timestamp?: string | number;
  taken_at?: string | number;
  date?: string | number;
  author?: { display_name?: string; username?: string };
}
interface ScItem {
  post?: ScPost;
}
interface ScEnvelope {
  success?: boolean;
  data?: ScItem | ScItem[] | { items?: ScItem[]; reels?: ScItem[]; posts?: ScItem[]; videos?: ScItem[]; results?: ScItem[] };
  credits_used?: number;
  credits_remaining?: number;
  cached?: boolean;
}

export interface ScCall {
  status: number;
  json: ScEnvelope | null;
  creditsUsed: number;
  cached: boolean;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

const VIDEO_FILE = /\.(mp4|m3u8|webm|mov|m4v)(\?|$)/i;
const BAD_THUMB = /placeholder|default[_-]?avatar|no[_-]?image|blank\.|spacer\./i;

/** A usable thumbnail is a valid-looking https IMAGE URL — never the video file,
 *  a placeholder, an empty string, or a non-URL. We do NOT reject by image format
 *  (e.g. HEIC): the URL is stored and the browser attempts to render it, falling
 *  back to the branded placeholder via onError. (TikTok HEIC covers are stored as
 *  "valid_unverified" since the CDN blocks server-side verification.) */
function usableThumb(u: unknown, videoUrl: string | null): u is string {
  if (typeof u !== "string") return false;
  const s = u.trim();
  if (!s || !/^https?:\/\//i.test(s)) return false;
  if (videoUrl && s === videoUrl) return false;
  if (VIDEO_FILE.test(s)) return false;
  if (BAD_THUMB.test(s)) return false;
  return true;
}

/** Pick the best real thumbnail/cover from a SocialCrawl post across the field
 *  variants the API uses; returns null when none is usable (so the refresh
 *  update path keeps the last-known-good thumbnail rather than clobbering it). */
function pickThumbnail(post: ScPost): string | null {
  const c = post.content ?? {};
  const mv = c.media_urls;
  const videoUrl = typeof mv === "string" ? mv : Array.isArray(mv) ? (mv[0] ?? null) : null;
  const candidates: unknown[] = [
    c.thumbnail_url, c.thumbnailUrl, c.cover, c.cover_url, c.coverUrl, c.image, c.image_url,
    post.cover, post.cover_url, post.coverUrl, post.image, post.image_url,
    post.video?.cover, post.video?.cover_url, post.video?.coverUrl, post.video?.dynamic_cover,
  ];
  for (const cand of candidates) if (usableThumb(cand, videoUrl)) return cand;
  return null;
}

/** Encode credit usage into the attempt log without a schema change. */
function describe(platform: Platform, kind: string, call: ScCall, extra = ""): string {
  return `socialcrawl ${platform} ${kind} · ${call.creditsUsed}cr · cache:${call.cached ? "hit" : "miss"}${extra ? ` · ${extra}` : ""}`;
}

export class SocialCrawlProvider implements SocialPlatformProvider {
  platform: Platform;
  providerType = "socialcrawl" as const;
  supportsComments: boolean;
  supportsDiscovery = true;
  supportsSavesOrBookmarks = false;

  constructor(platform: Platform) {
    this.platform = platform;
    // TikTok/Instagram return comment COUNTS in the list; Facebook needs the
    // per-post detail call (run on the comment-detail tier).
    this.supportsComments = true;
  }

  readiness(): ProviderReadiness {
    if (!getSocialcrawlKey()) {
      return {
        ready: false,
        status: "token_missing",
        sourceStatus: "needs_api_key",
        detail: "Set SOCIALCRAWL_API_KEY (server env) to use SocialCrawl",
      };
    }
    return { ready: true, status: "live", sourceStatus: "live", detail: null };
  }

  private async call(path: string): Promise<ScCall> {
    const key = getSocialcrawlKey();
    if (!key) throw new Error("SOCIALCRAWL_API_KEY not configured");
    const res = await fetch(`${BASE}${path}`, {
      headers: { "x-api-key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(45000),
    });
    let json: ScEnvelope | null = null;
    try {
      json = (await res.json()) as ScEnvelope;
    } catch {
      json = null;
    }
    if (!res.ok) {
      // Never include the key (it's only in the header, not the message).
      throw new Error(`SocialCrawl ${path.split("?")[0]} failed (HTTP ${res.status})`);
    }
    return { status: res.status, json, creditsUsed: json?.credits_used ?? 0, cached: Boolean(json?.cached) };
  }

  private itemsOf(json: ScEnvelope | null): ScItem[] {
    const d = json?.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    if ("post" in d) return [d as ScItem];
    const o = d as { items?: ScItem[]; reels?: ScItem[]; posts?: ScItem[]; videos?: ScItem[]; results?: ScItem[] };
    return o.items ?? o.reels ?? o.posts ?? o.videos ?? o.results ?? [];
  }

  private normalize(item: ScItem): NormalizedVideo | null {
    const post = item.post;
    if (!post) return null;
    const url = post.url ?? post.permalink ?? null;
    const parsed = url ? parseVideoUrl(url) : null;
    const e = post.engagement ?? {};
    return {
      platform: this.platform,
      // Canonical URL + stable id so this matches the tracked video (Part 8).
      originalUrl: parsed?.canonicalUrl ?? url,
      externalVideoId: parsed?.externalVideoId ?? post.id ?? null,
      title: typeof post.content?.text === "string" ? post.content.text.slice(0, 80) : null,
      caption: post.content?.text ?? null,
      thumbnailUrl: pickThumbnail(post),
      // SocialCrawl published_at is Unix SECONDS — parse robustly (sec/ms/ISO →
      // ISO, invalid → null) so it never becomes a "Jan 1970" date.
      publishedAt:
        parseTimestamp(post.published_at) ??
        parseTimestamp(post.publishedAt) ??
        parseTimestamp(post.created_at) ??
        parseTimestamp(post.createdAt) ??
        parseTimestamp(post.timestamp) ??
        parseTimestamp(post.taken_at) ??
        parseTimestamp(post.date) ??
        null,
      authorName: post.author?.display_name ?? null,
      authorHandle: post.author?.username ?? null,
      views: num(e.views), // Facebook: PUBLIC Reel plays
      likes: num(e.likes),
      comments: num(e.comments),
      shares: num(e.shares),
      saves: num(e.saves),
      bookmarks: null,
      rawJson: { source: "socialcrawl", post },
    };
  }

  private profilePath(profile: PlatformProfile | null): string | null {
    const handle = profile?.handle ?? null;
    const url = profile?.profileUrl ?? null;
    if (this.platform === "tiktok") return handle ? `/tiktok/profile/videos?handle=${encodeURIComponent(handle)}` : null;
    if (this.platform === "instagram") return handle ? `/instagram/profile/reels?handle=${encodeURIComponent(handle)}` : null;
    if (this.platform === "facebook") return url ? `/facebook/profile/reels?url=${encodeURIComponent(url)}` : null;
    return null;
  }

  async getVideoMetadata(url: string): Promise<NormalizedVideo | null> {
    const endpoint =
      this.platform === "facebook"
        ? `/facebook/post?url=${encodeURIComponent(url)}`
        : this.platform === "instagram"
          ? `/instagram/post?url=${encodeURIComponent(url)}`
          : `/tiktok/post?url=${encodeURIComponent(url)}`;
    const call = await this.call(endpoint);
    const item = this.itemsOf(call.json)[0];
    return item ? this.normalize(item) : null;
  }

  async getVideoMetrics(video: Video): Promise<NormalizedVideo | null> {
    return this.getVideoMetadata(video.originalUrl);
  }

  /** SocialCrawl exposes comment COUNTS (in metrics), not comment TEXT here.
   * Return [] so existing comment text is preserved (never wiped). */
  async getVideoComments(): Promise<NormalizedComment[]> {
    return [];
  }

  async discoverNewVideos(profile: PlatformProfile): Promise<NormalizedVideo[]> {
    const path = this.profilePath(profile);
    if (!path) return [];
    const call = await this.call(path);
    return this.itemsOf(call.json)
      .map((it) => this.normalize(it))
      .filter((v): v is NormalizedVideo => v !== null);
  }

  async fetchPlatform(
    profile: PlatformProfile | null,
    videos: Video[],
    _since: Date,
    opts: PlatformFetchOptions = {},
  ): Promise<PlatformFetchResult> {
    const wantComments = opts.wantComments ?? true;
    const attempts: AttemptDraft[] = [];
    const path = this.profilePath(profile);
    if (!path) {
      throw new Error(`SocialCrawl: no profile handle/URL for ${this.platform}`);
    }

    // 1) Profile list — one call: views (+ engagement for TikTok/Instagram).
    const call = await this.call(path);
    const byId = new Map<string, NormalizedVideo>();
    for (const it of this.itemsOf(call.json)) {
      const n = this.normalize(it);
      if (n) byId.set(n.externalVideoId ?? n.originalUrl ?? Math.random().toString(), n);
    }
    attempts.push({
      provider: "socialcrawl",
      actorId: null,
      kind: "metrics",
      inputDescription: describe(this.platform, "profile", call, `${byId.size} posts`),
      success: byId.size > 0,
      runId: null,
      itemCount: byId.size,
      error: byId.size > 0 ? null : "SocialCrawl returned no posts",
    });

    // 2) Comment-detail tier: Facebook's reels list returns views only, so on a
    // detail cycle fetch per-post engagement (likes/comments/shares) for the
    // TRACKED reels only — never broad discovery.
    if (wantComments && this.platform === "facebook") {
      for (const v of videos) {
        try {
          const detail = await this.call(`/facebook/post?url=${encodeURIComponent(v.originalUrl)}`);
          const item = this.itemsOf(detail.json)[0];
          const n = item ? this.normalize(item) : null;
          attempts.push({
            provider: "socialcrawl",
            actorId: null,
            kind: "detail",
            inputDescription: describe(this.platform, "post", detail, v.externalVideoId ?? v.id),
            success: Boolean(n),
            runId: null,
            itemCount: n ? 1 : 0,
            error: n ? null : "no item",
          });
          if (n) {
            const key = n.externalVideoId ?? n.originalUrl ?? "";
            const existing = byId.get(key);
            // Per-post has full engagement; keep the (equal) views, fill likes/comments/shares.
            byId.set(key, existing ? { ...existing, likes: n.likes, comments: n.comments, shares: n.shares } : n);
          }
        } catch (e) {
          attempts.push({
            provider: "socialcrawl",
            actorId: null,
            kind: "detail",
            inputDescription: `socialcrawl facebook post · failed`,
            success: false,
            runId: null,
            itemCount: 0,
            error: e instanceof Error ? e.message.slice(0, 160) : String(e),
          });
        }
      }
    }

    return { videos: [...byId.values()], commentsByVideo: {}, attempts };
  }
}
