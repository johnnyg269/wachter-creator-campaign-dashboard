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
  creditsRemaining: number | null;
  cached: boolean;
}

// Individual comment from /{platform}/post/comments — unified across TikTok,
// Instagram, and Facebook: data.items[].comment. published_at is Unix SECONDS
// (number) on TikTok and an ISO/string on IG/FB, so it MUST go through
// parseTimestamp (never new Date() directly).
interface ScComment {
  id?: string;
  parent_id?: string | null;
  post_id?: string | null;
  text?: string;
  author?: { username?: string; display_name?: string | null; verified?: boolean | null };
  engagement?: { likes?: number; replies?: number | null };
  flags?: { pinned?: boolean | null; deleted?: boolean | null };
  published_at?: string | number;
  created_at?: string | number;
}
interface ScCommentEnvelope {
  data?: { items?: Array<{ comment?: ScComment }>; total?: number; next_cursor?: string | null } | Array<{ comment?: ScComment }>;
  credits_used?: number;
  cached?: boolean;
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

/** Encode credit usage into the attempt log without a schema change. The
 *  `rem:<n>` token carries SocialCrawl's reported credits_remaining so the admin
 *  credit panel can surface the live balance (credit-policy parses it). */
function describe(platform: Platform, kind: string, call: ScCall, extra = ""): string {
  const rem = call.creditsRemaining !== null ? ` · rem:${call.creditsRemaining}` : "";
  return `socialcrawl ${platform} ${kind} · ${call.creditsUsed}cr · cache:${call.cached ? "hit" : "miss"}${rem}${extra ? ` · ${extra}` : ""}`;
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
    return {
      status: res.status,
      json,
      creditsUsed: json?.credits_used ?? 0,
      creditsRemaining: typeof json?.credits_remaining === "number" ? json.credits_remaining : null,
      cached: Boolean(json?.cached),
    };
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

  /** Parse one SocialCrawl comment into our normalized shape; null when empty
   *  or deleted (never store an empty/placeholder comment). */
  private parseComment(c: ScComment): NormalizedComment | null {
    const text = typeof c.text === "string" ? c.text.trim() : "";
    if (!text || c.flags?.deleted) return null;
    return {
      externalCommentId: c.id ?? null, // stable id → dedupe key
      authorName: c.author?.display_name?.trim() || c.author?.username?.trim() || null,
      text,
      // TikTok published_at is Unix SECONDS; IG/FB is a string — parseTimestamp
      // handles sec/ms/ISO → ISO and rejects junk (never "Jan 1970").
      postedAt: parseTimestamp(c.published_at) ?? parseTimestamp(c.created_at) ?? null,
      likes: num(c.engagement?.likes),
      replyCount: num(c.engagement?.replies),
      permalink: null,
      rawJson: null,
    };
  }

  private commentItemsOf(json: ScCommentEnvelope | null): ScComment[] {
    const d = json?.data as
      | { items?: unknown[]; comments?: unknown[]; results?: unknown[] }
      | unknown[]
      | undefined;
    const arr: unknown[] = Array.isArray(d)
      ? d
      : Array.isArray(json) // tolerate a bare top-level array too
        ? (json as unknown[])
        : (d?.items ?? d?.comments ?? d?.results ?? []);
    return arr
      .map((it) =>
        it && typeof it === "object" && "comment" in it
          ? (it as { comment?: ScComment }).comment
          : (it as ScComment),
      )
      .filter((c): c is ScComment => Boolean(c));
  }

  /** Fetch one page of comments (newest/top) for a video — 1 credit. We do NOT
   *  paginate: the dashboard surfaces recent comments and accumulates across the
   *  twice-daily pulls (dedup by stable id), keeping cost at 1 credit/video. */
  private async fetchComments(url: string): Promise<{ comments: NormalizedComment[]; call: ScCall }> {
    const call = await this.call(`/${this.platform}/post/comments?url=${encodeURIComponent(url)}`);
    const comments = this.commentItemsOf(call.json as unknown as ScCommentEnvelope)
      .map((c) => this.parseComment(c))
      .filter((c): c is NormalizedComment => c !== null);
    return { comments, call };
  }

  /** Individual comment TEXT via /{platform}/post/comments. On failure returns
   *  [] so the pipeline preserves last-known-good comments (never wipes). */
  async getVideoComments(video: Video): Promise<NormalizedComment[]> {
    try {
      return (await this.fetchComments(video.originalUrl)).comments;
    } catch {
      return [];
    }
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
    // Option B: per-post comment-text + per-post detail (engagement) calls run
    // only for the hot-MTL subset when the caller restricts them; metrics for
    // everything else still come from the cheap profile sweep below.
    const commentTargets = opts.commentTargets ?? videos;
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

    // In-run SocialCrawl credit budget shared across BOTH the FB per-post detail
    // tier (step 2) and the comment-text tier (step 3) — a single comment cycle
    // can never overshoot the daily cap, even with many hot-MTL FB reels.
    let budget = opts.commentBudget ?? Infinity;

    // 2) Comment-detail tier: Facebook's reels list returns views only, so on a
    // detail cycle fetch per-post engagement (likes/comments/shares) for the
    // TRACKED reels only — never broad discovery. Each /facebook/post = 1 credit.
    if (wantComments && this.platform === "facebook") {
      for (const v of commentTargets) {
        if (budget <= 0) {
          attempts.push({
            provider: "socialcrawl",
            actorId: null,
            kind: "detail",
            inputDescription: `socialcrawl facebook post · skipped (credit budget reached)`,
            success: true,
            runId: null,
            itemCount: 0,
            error: null,
          });
          break;
        }
        try {
          const detail = await this.call(`/facebook/post?url=${encodeURIComponent(v.originalUrl)}`);
          budget -= 1;
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

    // 3) Comment TEXT tier (TikTok / Instagram / Facebook): on the twice-daily
    // comment cycle, pull one page of comments per TRACKED video via
    // /{platform}/post/comments. 1 credit/video; dedup-by-id happens in the
    // store. A per-video failure preserves last-known-good (we just skip it).
    const commentsByVideo: Record<string, NormalizedComment[]> = {};
    if (wantComments) {
      // Reuses the shared `budget` (already debited by the FB detail tier above).
      for (const v of commentTargets) {
        if (budget <= 0) {
          attempts.push({
            provider: "socialcrawl",
            actorId: null,
            kind: "comments",
            inputDescription: `socialcrawl ${this.platform} comments · skipped (credit budget reached)`,
            success: true,
            runId: null,
            itemCount: 0,
            error: null,
          });
          break;
        }
        try {
          const { comments, call: cc } = await this.fetchComments(v.originalUrl);
          budget -= 1;
          const key = v.externalVideoId ?? v.originalUrl ?? "";
          if (key && comments.length > 0) commentsByVideo[key] = comments;
          attempts.push({
            provider: "socialcrawl",
            actorId: null,
            kind: "comments",
            inputDescription: describe(this.platform, "comments", cc, `${comments.length} comments`),
            success: true,
            runId: null,
            itemCount: comments.length,
            error: null,
          });
        } catch (e) {
          attempts.push({
            provider: "socialcrawl",
            actorId: null,
            kind: "comments",
            inputDescription: `socialcrawl ${this.platform} comments · failed`,
            success: false,
            runId: null,
            itemCount: 0,
            error: e instanceof Error ? e.message.slice(0, 160) : String(e),
          });
        }
      }
    }

    return { videos: [...byId.values()], commentsByVideo, attempts };
  }
}
