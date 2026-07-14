// Read-only Facebook thumbnail audit. Classifies every FB video by its STORED
// thumbnail state, then LIVE-tests a sample of stored fbcdn URLs with the exact
// same anonymous server fetch the /api/thumb proxy uses — so we can tell an
// expired/blocked fbcdn URL (proxy would 404 → placeholder) from a live one.
// Pure reads: no writes, no provider credits, no Apify.

import { isAdminExcluded, videoCampaign } from "./campaigns";
import { getStore } from "./store";
import type { Store } from "./store/types";
import { isAllowedThumbHost } from "./thumb-proxy";
import { readThumbState, type ThumbnailStatus } from "./thumbnail-state";
import type { Video } from "./types";

const LIVE_SAMPLE = 40;
const FETCH_TIMEOUT_MS = 7000;

/** Same check the /api/thumb proxy performs: ok + image content-type. */
async function probe(url: string): Promise<{ live: boolean; detail: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store", headers: { Accept: "image/*" } });
    const type = r.headers.get("content-type") ?? "";
    if (r.ok && type.startsWith("image/")) return { live: true, detail: `ok ${type}` };
    return { live: false, detail: `HTTP ${r.status}${type ? ` ${type}` : ""}` };
  } catch {
    return { live: false, detail: "fetch failed/timeout" };
  }
}

export interface FbThumbAudit {
  generatedAt: string;
  totalFacebook: number;
  /** By stored thumbnail-state status. */
  byStatus: Record<ThumbnailStatus | "no_url", number>;
  storedUrlPresent: number;
  storedUrlMissing: number;
  hostBreakdown: Record<string, number>;
  excluded: number;
  /** Videos with a stored URL but NOT in the recent profile-sweep window (proxy
   *  can't refresh them) — bootcamp + older reels whose URL will expire. */
  notRecentlyRefreshed24h: number;
  liveTest: {
    sampled: number;
    liveOk: number;
    expiredOrBlocked: number;
    examples: Array<{ campaign: string | null; publishedAt: string | null; lastRefreshedAt: string | null; thumbStatus: string; live: boolean; detail: string }>;
  };
  explanation: string;
}

export async function auditFacebookThumbnails(store: Store = getStore(), now: Date = new Date()): Promise<FbThumbAudit> {
  const all = await store.listVideos({ includeHidden: true });
  const fb = all.filter((v) => v.platform === "facebook");

  const byStatus = { valid: 0, valid_unverified: 0, retry_pending: 0, failed: 0, missing: 0, placeholder: 0, no_url: 0 } as Record<ThumbnailStatus | "no_url", number>;
  const hostBreakdown: Record<string, number> = {};
  let storedUrlPresent = 0, storedUrlMissing = 0, excluded = 0, notRecent = 0;
  const withUrl: Video[] = [];

  for (const v of fb) {
    if (isAdminExcluded(v)) excluded++;
    const st = readThumbState(v.rawJson).status;
    if (!v.thumbnailUrl) {
      byStatus.no_url++;
      storedUrlMissing++;
    } else {
      byStatus[st] = (byStatus[st] ?? 0) + 1;
      storedUrlPresent++;
      withUrl.push(v);
      try {
        const host = new URL(v.thumbnailUrl).hostname.split(".").slice(-2).join(".");
        hostBreakdown[host] = (hostBreakdown[host] ?? 0) + 1;
      } catch {
        hostBreakdown["(invalid)"] = (hostBreakdown["(invalid)"] ?? 0) + 1;
      }
      const lr = v.lastRefreshedAt ? new Date(v.lastRefreshedAt).getTime() : 0;
      if (now.getTime() - lr > 24 * 3_600_000) notRecent++;
    }
  }

  // Live-test a sample of stored fbcdn URLs — oldest-refreshed first (most likely
  // expired) — via the same fetch the proxy uses. Skip excluded videos.
  const sampleable = withUrl
    .filter((v) => !isAdminExcluded(v) && v.thumbnailUrl && isAllowedThumbHost(v.thumbnailUrl))
    .sort((a, b) => (a.lastRefreshedAt ?? "").localeCompare(b.lastRefreshedAt ?? ""))
    .slice(0, LIVE_SAMPLE);
  let liveOk = 0, expired = 0;
  const examples: FbThumbAudit["liveTest"]["examples"] = [];
  for (const v of sampleable) {
    const res = await probe(v.thumbnailUrl!);
    if (res.live) liveOk++; else expired++;
    if (examples.length < 12) {
      examples.push({
        campaign: videoCampaign(v),
        publishedAt: v.publishedAt,
        lastRefreshedAt: v.lastRefreshedAt,
        thumbStatus: readThumbState(v.rawJson).status,
        live: res.live,
        detail: res.detail,
      });
    }
  }

  const expiredRate = sampleable.length ? expired / sampleable.length : 0;
  const explanation =
    sampleable.length === 0
      ? "No stored fbcdn URLs to test — most FB videos have no stored thumbnail URL."
      : expiredRate > 0.4
        ? `${expired}/${sampleable.length} sampled stored fbcdn URLs FAIL the proxy fetch (expired/blocked signed URLs). Facebook fbcdn URLs are time-signed; once expired the /api/thumb proxy 404s and the UI shows the branded placeholder. Videos not in the recent profile sweep (${notRecent} FB videos not refreshed in 24h — bootcamp + older reels) keep the expired URL forever. FIX = refresh those URLs via a capped FB detail repair; the safest durable fix caches the image bytes so it survives the next expiry.`
        : `Most sampled fbcdn URLs are live (${liveOk}/${sampleable.length}); missing thumbnails are dominated by ${byStatus.no_url} videos with NO stored URL (provider never returned one) rather than expiry.`;

  return {
    generatedAt: now.toISOString(),
    totalFacebook: fb.length,
    byStatus,
    storedUrlPresent,
    storedUrlMissing,
    hostBreakdown,
    excluded,
    notRecentlyRefreshed24h: notRecent,
    liveTest: { sampled: sampleable.length, liveOk, expiredOrBlocked: expired, examples },
    explanation,
  };
}
