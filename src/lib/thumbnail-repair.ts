// Immediate, safe thumbnail repair for active campaign videos missing a cover.
//
// Runs on demand (admin "Repair missing thumbnails now" or a server trigger) —
// NOT tied to the 2-hourly discovery cycle. For each active, eligible campaign
// video with no thumbnail it fetches the provider's per-video detail
// (SocialCrawl /tiktok|instagram|facebook/post, or the YouTube Data API) and
// stores the recovered cover. Guarantees:
//   - NEVER calls Apify (resolveProvider is invoked with apifyAllowed=false, so
//     the resolved provider is SocialCrawl/YouTube-API only — no Apify fallback).
//   - Stays within the SocialCrawl daily credit cap.
//   - Only active, campaign-eligible videos (never excluded/quarantined/hidden).
//   - Never overwrites a good/last-known-good thumbnail (nextThumbnailState).
//   - TikTok covers (CDN unverifiable from Vercel) are stored valid_unverified.
//   - Records the exact reason for every cover it could not recover.

import { resolveProvider } from "./providers/registry";
import { campaignStartMs, isCampaignEligible, isReviewCandidate, UNASSIGNED_EPISODE_NAME } from "./eligibility";
import { mergeThumbIntoRaw, nextThumbnailState, readThumbState } from "./thumbnail-state";
import { isTikTokCdnHost } from "./thumb-proxy";
import { getRefreshPolicyConfig, socialcrawlCreditsToday } from "./refresh-policy";
import type { Store } from "./store/types";
import type { NormalizedVideo, Platform, Video } from "./types";

export interface ThumbnailRepairFailure {
  videoId: string;
  platform: Platform;
  slug: string;
  reason: string;
}

export interface ThumbnailRepairResult {
  /** Active eligible videos that had no thumbnail at the start of the run. */
  missingAtStart: number;
  /** Videos a detail lookup was actually attempted for. */
  checked: number;
  /** Covers successfully recovered (incl. TikTok valid_unverified). */
  repaired: number;
  /** Still without a cover after the run (= failures.length). */
  stillMissing: number;
  byPlatform: Record<string, { missing: number; checked: number; repaired: number }>;
  failures: ThumbnailRepairFailure[];
  creditCapReached: boolean;
  ranAt: string;
}

const DEFAULT_MAX = 80; // safety ceiling, far above the realistic missing count

function slugOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export async function repairMissingThumbnails(
  store: Store,
  opts: { maxTotal?: number; force?: boolean } = {},
): Promise<ThumbnailRepairResult> {
  const maxTotal = opts.maxTotal ?? DEFAULT_MAX;
  // force=true (explicit admin "Repair now") also retries covers previously
  // marked "failed" by the profile-based retry loop — the per-video DETAIL
  // endpoint is a different source they may never have been tried against. The
  // automatic/default path keeps the anti-churn skip so it never re-spends.
  const force = opts.force ?? false;
  const ranAt = new Date().toISOString();
  const cfg = getRefreshPolicyConfig();
  const startMs = campaignStartMs();
  const groups = await store.listEpisodeGroups();
  const unassignedId = groups.find((g) => g.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;

  // Active, eligible campaign videos that currently have no stored thumbnail.
  // Excludes pending discovery-review candidates (defense-in-depth, mirroring
  // the public query convention) — they're not counted anywhere public, so we
  // never spend a credit repairing one.
  const missing = (await store.listVideos({ includeHidden: true }))
    .filter((v) => !v.hidden)
    .filter((v) => !isReviewCandidate(v))
    .filter((v) => isCampaignEligible(v, startMs, unassignedId))
    .filter((v) => !v.thumbnailUrl);

  const result: ThumbnailRepairResult = {
    missingAtStart: missing.length,
    checked: 0,
    repaired: 0,
    stillMissing: 0,
    byPlatform: {},
    failures: [],
    creditCapReached: false,
    ranAt,
  };
  for (const v of missing) {
    result.byPlatform[v.platform] ??= { missing: 0, checked: 0, repaired: 0 };
    result.byPlatform[v.platform].missing++;
  }
  if (missing.length === 0) return result;

  // SocialCrawl credit budget — never exceed the daily cap (YouTube API is free).
  const attempts = await store.listCollectionAttempts(1000);
  let scCredits = socialcrawlCreditsToday(attempts, new Date(), cfg.quietTimezone).credits;
  const scCap = cfg.socialcrawlDailyCreditCap;

  // Resolve each platform's provider once. apifyAllowed=false ⇒ NEVER Apify.
  const providerCache = new Map<Platform, Awaited<ReturnType<typeof resolveProvider>>>();
  const providerFor = async (p: Platform) => {
    const cached = providerCache.get(p);
    if (cached) return cached;
    const resolved = await resolveProvider(p, store, false);
    providerCache.set(p, resolved);
    return resolved;
  };

  let processed = 0;
  for (const v of missing) {
    const fail = (reason: string) => {
      result.failures.push({ videoId: v.id, platform: v.platform, slug: slugOf(v.originalUrl), reason });
    };
    if (processed >= maxTotal) {
      fail("not processed this run (batch ceiling reached) — re-run to continue");
      continue;
    }
    // Skip covers that already exhausted the retry cap at source — re-fetching
    // them spends a credit every run with no chance of recovery (matches the
    // discovery thumbnail-retry backoff). An explicit force run overrides this
    // (the detail endpoint is a source the profile-retry loop never tried).
    const prev = readThumbState(v.rawJson);
    if (!force && prev.status === "failed") {
      fail("thumbnail unavailable at source after max retries (use Repair now to force a detail retry)");
      continue;
    }
    const { provider } = await providerFor(v.platform);
    const usesSocialcrawl = provider.providerType === "socialcrawl";
    if (usesSocialcrawl && scCap > 0 && scCredits >= scCap) {
      result.creditCapReached = true;
      fail("SocialCrawl daily credit cap reached — repair resumes after the cap resets");
      continue;
    }
    if (!provider.getVideoMetadata) {
      fail(`no per-video detail lookup for ${v.platform} (provider not connected)`);
      continue;
    }

    result.checked++;
    result.byPlatform[v.platform].checked++;
    processed++;

    let detail: NormalizedVideo | null = null;
    let err: string | null = null;
    try {
      detail = await provider.getVideoMetadata(v.originalUrl);
      if (usesSocialcrawl) scCredits++; // 1 credit per detail call
    } catch (e) {
      err = e instanceof Error ? e.message.slice(0, 140) : "provider error";
    }

    const now2 = new Date().toISOString();
    const ts = nextThumbnailState({
      resolvedUrl: detail?.thumbnailUrl ?? null,
      existingUrl: v.thumbnailUrl,
      prev,
      isDiscovery: true,
      now: now2,
      // TikTok CDN can't be server-verified → valid_unverified; fbcdn/cdninstagram
      // ARE proxiable → valid.
      verifiable: !isTikTokCdnHost(detail?.thumbnailUrl),
    });
    await store.updateVideo(v.id, {
      thumbnailUrl: ts.thumbnailUrl,
      rawJson: mergeThumbIntoRaw(v.rawJson, ts.thumb) as Video["rawJson"],
    });

    // Audit + credit accounting (admin visibility); only SocialCrawl spends.
    if (usesSocialcrawl) {
      await store.addCollectionAttempt({
        refreshRunId: null,
        platform: v.platform,
        provider: "socialcrawl",
        actorId: null,
        kind: "detail",
        inputDescription: `socialcrawl ${v.platform} thumb-repair · 1cr · ${detail?.thumbnailUrl ? "recovered" : "none"}`,
        success: Boolean(detail?.thumbnailUrl),
        runId: null,
        itemCount: detail?.thumbnailUrl ? 1 : 0,
        error: detail?.thumbnailUrl ? null : err ?? "no thumbnail in detail response",
        capturedAt: now2,
      });
    }

    if (ts.thumbnailUrl) {
      result.repaired++;
      result.byPlatform[v.platform].repaired++;
    } else {
      fail(err ?? "provider returned no usable thumbnail (cover unavailable at source)");
    }
  }

  result.stillMissing = result.failures.length;
  return result;
}

/** Build a one-line ET timestamp-free admin summary (no secrets). */
export function summarizeRepair(r: ThumbnailRepairResult): string {
  return `Checked ${r.checked} of ${r.missingAtStart} missing · repaired ${r.repaired} · ${r.stillMissing} still missing${r.creditCapReached ? " · credit cap reached" : ""}`;
}
