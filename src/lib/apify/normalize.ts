// Defensive normalizer: maps wildly varying actor output shapes onto our
// NormalizedVideo / NormalizedComment. Unknown fields stay null — the UI shows
// "Unavailable", never a fake zero.

import type { NormalizedComment, NormalizedVideo, Platform } from "../types";
import { parseVideoUrl } from "../url-parse";
import { deepFindMetric } from "./deep-extract";

type Raw = Record<string, unknown>;

/** Dot-path getter: pick(obj, "stats.playCount"). */
function pick(obj: Raw, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Raw)[key];
  }
  return cur;
}

function firstNumber(obj: Raw, paths: string[]): number | null {
  for (const p of paths) {
    const v = pick(obj, p);
    if (typeof v === "number" && isFinite(v) && v >= 0) return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) {
      const n = Number(v);
      if (n >= 0) return n;
    }
  }
  return null;
}

function firstString(obj: Raw, paths: string[]): string | null {
  for (const p of paths) {
    const v = pick(obj, p);
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

function firstDate(obj: Raw, paths: string[]): string | null {
  for (const p of paths) {
    const v = pick(obj, p);
    if (typeof v === "number" && v > 1_000_000_000) {
      // unix seconds or millis
      const ms = v > 100_000_000_000 ? v : v * 1000;
      const d = new Date(ms);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof v === "string" && v.trim() !== "") {
      const s = v.trim();
      if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
      if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
      const d = new Date(s);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  return null;
}

const VIEW_PATHS = [
  "views", "viewCount", "playCount", "videoViewCount", "videoPlayCount",
  "stats.playCount", "viewsCount", "video_view_count", "play_count",
  "shortViewCount", "viewCountText",
];
const LIKE_PATHS = [
  "likes", "likeCount", "diggCount", "stats.diggCount", "likesCount",
  "like_count", "reactionsCount", "reactions", "topReactionsCount", "numberOfLikes",
  // Facebook posts scraper (GraphQL-shaped)
  "likers.count", "unified_reactors.count", "feedback.reaction_count.count",
];
const COMMENT_COUNT_PATHS = [
  "comments", "commentCount", "commentsCount", "stats.commentCount",
  "comment_count", "numberOfComments",
  // Facebook posts scraper
  "total_comment_count", "feedback.total_comment_count",
];
const SHARE_PATHS = [
  "shares", "shareCount", "stats.shareCount", "sharesCount", "share_count",
  "numberOfShares", "resharesCount",
  // Facebook posts scraper
  "share_count_reduced", "feedback.share_count.count",
];
const SAVE_PATHS = [
  "saves", "saveCount", "savesCount", "collectCount", "stats.collectCount", "bookmarks",
];
const TITLE_PATHS = ["title", "videoTitle", "name"];
const CAPTION_PATHS = [
  "text", "caption", "description", "desc", "videoDescription", "content",
  // Facebook posts scraper nests caption text in message.text
  "message.text", "message",
];
const THUMB_PATHS = [
  "thumbnail", "thumbnailUrl", "cover", "coverUrl", "displayUrl", "imageUrl",
  "videoMeta.coverUrl", "covers.default", "covers.origin", "thumbnails.0.url",
  "previewImage", "image", "displayResources.0.src",
  // Facebook posts scraper
  "short_form_video_context.playback_video.preferred_thumbnail.image.uri",
  "short_form_video_context.playback_video.thumbnailImage.uri",
  "short_form_video_context.video.first_frame_thumbnail",
];
const DATE_PATHS = [
  "createTime", "createTimeISO", "timestamp", "takenAt", "taken_at",
  "publishedAt", "uploadDate", "date", "time", "postedAt", "publishedTime",
  "creation_time", "uploadedAt",
];
const URL_PATHS = [
  "webVideoUrl", "url", "postUrl", "videoUrl", "link", "shareUrl",
  "permalink", "postPage", "topLevelUrl", "facebookUrl", "inputUrl", "shortUrl",
];
const ID_PATHS = [
  "id", "videoId", "postId", "itemId", "shortCode", "shortcode", "code", "post_id", "aweme_id",
];
const AUTHOR_NAME_PATHS = [
  "authorMeta.nickName", "authorMeta.name", "author.name", "author.nickname",
  "ownerFullName", "ownerUsername", "channelName", "channelTitle", "user.username",
  "pageName", "authorName", "creator", "username", "author",
];
const AUTHOR_HANDLE_PATHS = [
  "authorMeta.name", "author.uniqueId", "ownerUsername", "channelUsername",
  "channelHandle", "user.username", "authorHandle",
];

/**
 * Normalize one actor dataset item into a video record. Returns null when the
 * item has no recognizable video signal at all (no url/id and no metrics).
 */
export function normalizeVideoItem(raw: Raw, platform: Platform): NormalizedVideo | null {
  // Some actors nest the real payload (e.g. { post: {...} } or { video: {...} })
  const nested = ["post", "video", "reel", "item", "data"]
    .map((k) => pick(raw, k))
    .find((v) => v && typeof v === "object" && !Array.isArray(v));
  const obj = { ...((nested as Raw) ?? {}), ...raw };

  const url = firstString(obj, URL_PATHS);
  let externalVideoId = firstString(obj, ID_PATHS);
  if (url && !externalVideoId) {
    externalVideoId = parseVideoUrl(url)?.externalVideoId ?? null;
  }

  let views = firstNumber(obj, VIEW_PATHS);
  let likes = firstNumber(obj, LIKE_PATHS);
  let comments = firstNumber(obj, COMMENT_COUNT_PATHS);
  let shares = firstNumber(obj, SHARE_PATHS);

  // Defense-in-depth: when the explicit path lists miss, walk the raw object
  // for known metric field names (records the path for debuggability).
  if (views === null) views = deepFindMetric(obj, "views")?.value ?? null;
  if (likes === null) likes = deepFindMetric(obj, "likes")?.value ?? null;
  if (comments === null) comments = deepFindMetric(obj, "comments")?.value ?? null;
  if (shares === null) shares = deepFindMetric(obj, "shares")?.value ?? null;

  if (!url && !externalVideoId && views === null && likes === null) return null;

  const title = firstString(obj, TITLE_PATHS);
  const caption = firstString(obj, CAPTION_PATHS);

  return {
    platform,
    originalUrl: url ? (parseVideoUrl(url)?.canonicalUrl ?? url) : null,
    externalVideoId,
    title: title ?? (caption ? caption.slice(0, 80) : null),
    caption: caption ?? null,
    thumbnailUrl: firstString(obj, THUMB_PATHS),
    publishedAt: firstDate(obj, DATE_PATHS),
    authorName: firstString(obj, AUTHOR_NAME_PATHS),
    authorHandle: firstString(obj, AUTHOR_HANDLE_PATHS),
    views,
    likes,
    comments,
    shares,
    saves: firstNumber(obj, SAVE_PATHS),
    bookmarks: null, // folded into saves via SAVE_PATHS; kept for schema parity
    rawJson: raw,
  };
}

const COMMENT_LIST_PATHS = ["comments", "latestComments", "topComments", "commentsList", "items"];
const COMMENT_TEXT_PATHS = ["text", "comment", "content", "message", "body"];
const COMMENT_AUTHOR_PATHS = [
  "ownerUsername", "author", "authorName", "username", "user.username",
  "uniqueId", "profileName", "name", "owner.username",
];
const COMMENT_ID_PATHS = ["cid", "id", "commentId", "comment_id"];
const COMMENT_DATE_PATHS = ["createTime", "createTimeISO", "timestamp", "date", "postedAt", "time"];
const COMMENT_LIKE_PATHS = ["diggCount", "likesCount", "likeCount", "likes", "voteCount"];
const COMMENT_REPLY_PATHS = ["replyCommentTotal", "repliesCount", "replyCount", "replies"];

export function normalizeCommentItem(raw: Raw): NormalizedComment | null {
  const text = firstString(raw, COMMENT_TEXT_PATHS);
  if (!text) return null;
  const replies = pick(raw, "replies");
  return {
    externalCommentId: firstString(raw, COMMENT_ID_PATHS),
    authorName: firstString(raw, COMMENT_AUTHOR_PATHS),
    text,
    postedAt: firstDate(raw, COMMENT_DATE_PATHS),
    likes: firstNumber(raw, COMMENT_LIKE_PATHS),
    replyCount: Array.isArray(replies) ? replies.length : firstNumber(raw, COMMENT_REPLY_PATHS),
    permalink: firstString(raw, ["permalink", "commentUrl", "url"]),
    rawJson: raw,
  };
}

/** Extract embedded comments from a video item, when the actor includes them. */
export function extractEmbeddedComments(raw: Raw): NormalizedComment[] {
  for (const path of COMMENT_LIST_PATHS) {
    const v = pick(raw, path);
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object") {
      return (v as Raw[])
        .map(normalizeCommentItem)
        .filter((c): c is NormalizedComment => c !== null);
    }
  }
  return [];
}

/**
 * Merge two normalized records for the SAME video coming from different
 * surfaces of the same platform (e.g. Facebook feed item + reel-page item).
 * Base wins for every non-null field; extra only fills gaps — so the surface
 * that exposes views (feed) is never clobbered by the one that doesn't.
 */
export function mergeNormalizedVideos(
  base: NormalizedVideo,
  extra: NormalizedVideo,
): NormalizedVideo {
  return {
    platform: base.platform,
    originalUrl: base.originalUrl ?? extra.originalUrl,
    externalVideoId: base.externalVideoId ?? extra.externalVideoId,
    title: base.title ?? extra.title,
    caption: base.caption ?? extra.caption,
    thumbnailUrl: base.thumbnailUrl ?? extra.thumbnailUrl,
    publishedAt: base.publishedAt ?? extra.publishedAt,
    authorName: base.authorName ?? extra.authorName,
    authorHandle: base.authorHandle ?? extra.authorHandle,
    views: base.views ?? extra.views,
    likes: base.likes ?? extra.likes,
    comments: base.comments ?? extra.comments,
    shares: base.shares ?? extra.shares,
    saves: base.saves ?? extra.saves,
    bookmarks: base.bookmarks ?? extra.bookmarks,
    rawJson: base.rawJson ?? extra.rawJson,
  };
}

/** Count of populated metric fields — used to pick the best merge base. */
export function metricCompleteness(n: NormalizedVideo): number {
  return [n.views, n.likes, n.comments, n.shares, n.saves].filter((v) => v !== null).length;
}

/**
 * Is this raw feed item actually a VIDEO? The Facebook posts scraper returns
 * every post type (photos, text, links) from a profile feed — only video/reel
 * items belong in a video campaign tracker. Other platforms' actors return
 * videos by construction.
 */
export function isLikelyVideoItem(raw: Raw, platform: Platform): boolean {
  if (platform !== "facebook") return true;
  const url = firstString(raw, URL_PATHS) ?? "";
  if (/\/reel\/|\/videos\/|\/watch\/?\?|fb\.watch/.test(url)) return true;
  // Video markers anywhere in the payload (reel context, playable media, …)
  const s = JSON.stringify(raw);
  return /short_form_video_context|playable_duration|"videoUrl"|"video_id"|VideoAttachment|is_video_broadcast/.test(
    s,
  );
}

export interface DetectedCapabilities {
  fields: string[];
  supportsMetadata: boolean;
  supportsMetrics: boolean;
  supportsComments: boolean;
}

/** Inspect raw items to report what a tested actor actually returns. */
export function detectCapabilities(items: Raw[], platform: Platform): DetectedCapabilities {
  const fields = new Set<string>();
  let metadata = false;
  let metrics = false;
  let comments = false;
  for (const item of items.slice(0, 5)) {
    for (const k of Object.keys(item)) fields.add(k);
    const n = normalizeVideoItem(item, platform);
    if (n) {
      if (n.title || n.caption || n.thumbnailUrl || n.publishedAt) metadata = true;
      if (n.views !== null || n.likes !== null || n.comments !== null) metrics = true;
    }
    if (extractEmbeddedComments(item).length > 0) comments = true;
    // clockworks-style actors expose comments via a side dataset URL
    if (typeof item.commentsDatasetUrl === "string") comments = true;
  }
  return {
    fields: [...fields].sort(),
    supportsMetadata: metadata,
    supportsMetrics: metrics,
    supportsComments: comments,
  };
}
