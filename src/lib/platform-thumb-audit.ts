// Read-only per-platform thumbnail audit (TikTok / Instagram / Facebook /
// YouTube). Classifies every ACTIVE (non-excluded, eligible, non-review) video
// by stored thumbnail state + URL shape, and — for the proxiable CDNs only —
// live-probes a sample the exact way /api/thumb does. TikTok CANNOT be server-
// verified (its CDN blocks datacenter fetches), so for TikTok we instead surface
// the URL FORMAT (a .heic cover cannot render in any browser) and the raw cover
// fields SocialCrawl returned, so the real failure mode is visible from evidence.
// Pure reads: no writes, no provider credits, no Apify. URL query-param VALUES
// are never returned (only key names) so signed tokens never leak.

import { campaignStartMs, isCampaignEligible, isReviewCandidate, UNASSIGNED_EPISODE_NAME } from "./eligibility";
import { isAdminExcluded, videoCampaign } from "./campaigns";
import { getStore } from "./store";
import type { Store } from "./store/types";
import { isAllowedThumbHost, isTikTokCdnHost, probeImageUrl } from "./thumb-proxy";
import { readThumbState, type ThumbnailStatus } from "./thumbnail-state";
import { PLATFORMS, type Platform, type Video } from "./types";

const LIVE_SAMPLE = 24;
const URL_SAMPLES = 8;

type StatusKey = ThumbnailStatus | "no_url";
const emptyStatus = (): Record<StatusKey, number> => ({
  valid: 0, valid_unverified: 0, retry_pending: 0, failed: 0, missing: 0, placeholder: 0, no_url: 0,
});

function urlShape(url: string): { host: string; ext: string; paramKeys: string[]; heicHint: boolean } {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]{2,5})$/);
    const ext = m ? m[1] : "";
    const paramKeys = [...u.searchParams.keys()].sort();
    const heicHint = /heic|heif/i.test(url);
    return { host: u.hostname, ext, paramKeys, heicHint };
  } catch {
    return { host: "(invalid)", ext: "", paramKeys: [], heicHint: false };
  }
}

/** Field names on a raw SocialCrawl/actor payload that can carry a cover, so we
 *  can see WHICH one is stored vs. what alternatives existed (e.g. a jpeg
 *  dynamic_cover next to a heic cover). Reads shallow — never dumps rawJson. */
const COVER_FIELDS = [
  "thumbnail_url", "thumbnailUrl", "cover", "cover_url", "coverUrl", "image", "image_url",
  "originCover", "origin_cover", "dynamicCover", "dynamic_cover",
];
function rawCoverFields(rawJson: unknown): Array<{ field: string; ext: string; host: string }> {
  if (!rawJson || typeof rawJson !== "object") return [];
  const root = rawJson as Record<string, unknown>;
  const content = (root.content && typeof root.content === "object" ? root.content : {}) as Record<string, unknown>;
  const video = (root.video && typeof root.video === "object" ? root.video : {}) as Record<string, unknown>;
  const out: Array<{ field: string; ext: string; host: string }> = [];
  for (const scope of [content, root, video]) {
    for (const f of COVER_FIELDS) {
      const val = scope[f];
      if (typeof val === "string" && /^https?:\/\//i.test(val)) {
        const { ext, host } = urlShape(val);
        out.push({ field: f, ext: ext || "(none)", host });
      }
    }
  }
  return out;
}

export interface PlatformThumbStats {
  platform: Platform;
  totalActive: number;
  excludedSkipped: number;
  byStatus: Record<StatusKey, number>;
  storedUrlPresent: number;
  storedUrlMissing: number;
  hostBreakdown: Record<string, number>;
  /** URL file-extension distribution among stored covers (heic ⇒ won't render). */
  extBreakdown: Record<string, number>;
  proxiable: boolean;
  liveProbe: { sampled: number; ok: number; failed: number; note: string } | null;
  samples: Array<{
    campaign: string | null;
    publishedAt: string | null;
    lastRefreshedAt: string | null;
    thumbStatus: string;
    host: string;
    ext: string;
    paramKeys: string[];
    heicHint: boolean;
    rawCovers: Array<{ field: string; ext: string; host: string }>;
  }>;
}

export interface PlatformThumbAudit {
  generatedAt: string;
  byPlatform: PlatformThumbStats[];
  headline: string;
}

async function auditPlatform(all: Video[], platform: Platform, unassignedId: string | null, startMs: number): Promise<PlatformThumbStats> {
  const rows = all.filter((v) => v.platform === platform);
  const byStatus = emptyStatus();
  const hostBreakdown: Record<string, number> = {};
  const extBreakdown: Record<string, number> = {};
  let excludedSkipped = 0, storedUrlPresent = 0, storedUrlMissing = 0, totalActive = 0;
  const withUrl: Video[] = [];

  for (const v of rows) {
    if (isAdminExcluded(v) || v.hidden) { excludedSkipped++; continue; }
    if (isReviewCandidate(v)) continue;
    if (!isCampaignEligible(v, startMs, unassignedId)) continue;
    totalActive++;
    const st = readThumbState(v.rawJson).status;
    if (!v.thumbnailUrl) {
      byStatus.no_url++;
      storedUrlMissing++;
    } else {
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      storedUrlPresent++;
      withUrl.push(v);
      const { host, ext } = urlShape(v.thumbnailUrl);
      const h = host.split(".").slice(-2).join(".");
      hostBreakdown[h] = (hostBreakdown[h] ?? 0) + 1;
      extBreakdown[ext || "(none)"] = (extBreakdown[ext || "(none)"] ?? 0) + 1;
    }
  }

  const proxiable = platform !== "tiktok"; // TikTok CDN blocks server-side fetch
  let liveProbe: PlatformThumbStats["liveProbe"] = null;
  if (proxiable) {
    const sampleable = withUrl
      .filter((v) => v.thumbnailUrl && isAllowedThumbHost(v.thumbnailUrl) && !isTikTokCdnHost(v.thumbnailUrl))
      .sort((a, b) => (a.lastRefreshedAt ?? "").localeCompare(b.lastRefreshedAt ?? ""))
      .slice(0, LIVE_SAMPLE);
    let ok = 0, failed = 0;
    for (const v of sampleable) {
      const r = await probeImageUrl(v.thumbnailUrl!);
      if (r.live) ok++; else failed++;
    }
    liveProbe = { sampled: sampleable.length, ok, failed, note: "server proxy-fetch (same as /api/thumb)" };
  }

  // URL-shape samples — oldest-refreshed first (most likely expired). For TikTok
  // this reveals the format (.heic etc.) + which raw cover field was stored.
  const samples = withUrl
    .sort((a, b) => (a.lastRefreshedAt ?? "").localeCompare(b.lastRefreshedAt ?? ""))
    .slice(0, URL_SAMPLES)
    .map((v) => {
      const shape = urlShape(v.thumbnailUrl!);
      return {
        campaign: videoCampaign(v),
        publishedAt: v.publishedAt,
        lastRefreshedAt: v.lastRefreshedAt,
        thumbStatus: readThumbState(v.rawJson).status,
        host: shape.host,
        ext: shape.ext || "(none)",
        paramKeys: shape.paramKeys,
        heicHint: shape.heicHint,
        rawCovers: rawCoverFields(v.rawJson),
      };
    });

  return {
    platform,
    totalActive,
    excludedSkipped,
    byStatus,
    storedUrlPresent,
    storedUrlMissing,
    hostBreakdown,
    extBreakdown,
    proxiable,
    liveProbe,
    samples,
  };
}

export async function auditPlatformThumbnails(
  store: Store = getStore(),
  now: Date = new Date(),
  opts: { debugTikTokUrl?: boolean } = {},
): Promise<PlatformThumbAudit & { debugTikTokUrl?: string | null }> {
  const all = await store.listVideos({ includeHidden: true });
  const groups = await store.listEpisodeGroups();
  const unassignedId = groups.find((g) => g.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;
  const startMs = campaignStartMs();
  const byPlatform: PlatformThumbStats[] = [];
  for (const p of PLATFORMS) {
    byPlatform.push(await auditPlatform(all, p, unassignedId, startMs));
  }
  // Internal, admin-only render-test seam: one full TikTok cover URL so we can
  // empirically test whether a format rewrite survives the CDN signature. Never
  // surfaced publicly; the URL is an ephemeral signed CDN link, not a secret.
  let debugTikTokUrl: string | null | undefined = undefined;
  if (opts.debugTikTokUrl) {
    const tt = all.find(
      (v) => v.platform === "tiktok" && !v.hidden && !isAdminExcluded(v) && v.thumbnailUrl && /\.heic/i.test(v.thumbnailUrl),
    );
    debugTikTokUrl = tt?.thumbnailUrl ?? null;
  }
  const tt = byPlatform.find((p) => p.platform === "tiktok");
  const ttHeic = tt ? (tt.extBreakdown["heic"] ?? 0) + (tt.extBreakdown["heif"] ?? 0) : 0;
  const headline = tt
    ? `TikTok: ${tt.totalActive} active · ${tt.storedUrlMissing} no-URL · stored-URL by format ${JSON.stringify(tt.extBreakdown)}${ttHeic ? ` · ${ttHeic} HEIC (browser cannot render)` : ""}`
    : "no TikTok videos";
  return { generatedAt: now.toISOString(), byPlatform, headline };
}
