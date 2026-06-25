// One-time Bootcamp BACKFILL discovery (Phase 2B). A SEPARATE lane from ongoing
// metrics: it enumerates the historical back-catalog from the start date forward
// using a provider that PAGINATES (Apify profile scrapers for TikTok/Instagram/
// Facebook; the YouTube Data API for Shorts) — unlike SocialCrawl, whose profile
// endpoints return only ~10 recent items and don't paginate.
//
// SAFETY: admin-triggered only, dry-run first, hard caps (provider calls / cost /
// per-platform results), strict date floor, NEVER on cron, NEVER part of ongoing
// refresh. Running Apify here does NOT re-enable the ongoing-Apify kill switch —
// it requires its own explicit BACKFILL_DISCOVERY_ENABLED + _PROVIDER=apify. The
// dry run NEVER writes a video.

import {
  CANDIDATE_ACTORS,
  SEED_PROFILES,
  getActorIdFromEnv,
  getApifyToken,
  getYouTubeApiKey,
  type BackfillConfig,
} from "./config";
import { buildInputCandidates } from "./apify/input-builder";
import { isLikelyVideoItem, normalizeVideoItem } from "./apify/normalize";
import { YouTubeApiProvider } from "./providers/youtube-api-provider";
import { campaignStartMs, etMidnightMs } from "./eligibility";
import { isAdminExcluded, videoCampaign } from "./campaigns";
import { parseVideoUrl } from "./url-parse";
import {
  classifyCandidate,
  CANDIDATE_CLASS_LABEL,
  type CandidateClass,
} from "./bootcamp-import";
import type { NormalizedVideo, Platform, Video } from "./types";
import type { Store } from "./store/types";

export const BACKFILL_PLATFORMS: readonly Platform[] = ["tiktok", "instagram", "facebook", "youtube"];

/** Anchor (first Bootcamp video) per platform — used only as a reference point
 *  to confirm the enumeration reached the start of the campaign. */
const ANCHOR_ID: Record<Platform, string> = {
  tiktok: "7627682544586083614",
  instagram: "DXA4QZtDKMC",
  facebook: "826026589994871",
  youtube: "uAH54si-VJ8",
};

/** Backfill actor per platform: env override, else the recommended candidate
 *  (already verified for this campaign; YouTube uses the free Data API). */
export function backfillActorId(platform: Platform): string | null {
  if (platform === "youtube") return null;
  return getActorIdFromEnv(platform) ?? CANDIDATE_ACTORS.find((a) => a.platform === platform)?.actorId ?? null;
}

function profileUrlFor(platform: Platform): string | null {
  return SEED_PROFILES.find((p) => p.platform === platform)?.url ?? null;
}

/** Per-platform safety ceiling on results (the date floor usually stops sooner). */
const MAX_RESULTS_PER_PLATFORM = 250;
/** Per Apify run-sync wait (ms). */
const APIFY_RUN_TIMEOUT_MS = 270_000;
/** Conservative worst-case cost of one date-floored Apify profile run (observed
 *  ~$0.24 in the benchmark). Used for the PRE-SPEND cost-cap guard so the cap can
 *  abort BEFORE any Apify run, not just report after. */
const ESTIMATED_APIFY_RUN_COST_USD = 1.0;

export type StopReason =
  | "complete"
  | "reached_start_date"
  | "max_results"
  | "max_calls"
  | "max_cost"
  | "provider_limit"
  | "disabled"
  | "not_configured"
  | "error";

export interface BackfillCandidate {
  url: string | null;
  canonicalUrl: string | null;
  platform: Platform;
  externalVideoId: string | null;
  publishedAt: string | null;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  views: number | null;
  classification: CandidateClass;
  reason: string;
  suggestedCampaign: "bootcamp" | "mtl" | null;
  existingVideoId: string | null;
}

export interface BackfillPlatformReport {
  platform: Platform;
  provider: "apify" | "youtube_api" | "none";
  ran: boolean;
  /** Did the enumeration reach back to (or before) the start date? */
  canPaginate: boolean | null;
  candidatesFound: number;
  earliest: string | null;
  latest: string | null;
  anchorFound: boolean | null;
  byClass: Record<CandidateClass, number>;
  alreadyTracked: number;
  estCostUsd: number | null;
  providerCalls: number;
  stopReason: StopReason;
  candidates: BackfillCandidate[];
  notes: string[];
}

export interface BackfillDryRunReport {
  generatedAt: string;
  enabled: boolean;
  provider: string;
  startDate: string;
  platforms: BackfillPlatformReport[];
  totals: {
    candidatesFound: number;
    importable: number;
    suggestedBootcamp: number;
    overlap: number;
    alreadyMtl: number;
    alreadyBootcamp: number;
    alreadyExcluded: number;
    invalid: number;
    providerCalls: number;
    estCostUsd: number | null;
  };
  maxProviderCalls: number;
  maxCostUsd: number;
  wroteRecords: false;
}

function emptyByClass(): Record<CandidateClass, number> {
  return {
    suggested_bootcamp: 0,
    suggested_bootcamp_unresolved: 0,
    overlap: 0,
    before_start: 0,
    invalid_date: 0,
    invalid_url: 0,
    already_mtl: 0,
    already_bootcamp: 0,
    already_unassigned: 0,
    already_excluded: 0,
  };
}

const IMPORTABLE: ReadonlySet<CandidateClass> = new Set<CandidateClass>([
  "suggested_bootcamp",
  "overlap",
  "invalid_date",
]);
const MAX_DISPLAY = 80;

/** Run one Apify actor synchronously (date-floored) and return normalized videos
 *  + the run's actual cost. SEPARATE from the ongoing-Apify gate — only the
 *  backfill caller (with BACKFILL_DISCOVERY_PROVIDER=apify) reaches here. */
async function enumerateApify(
  platform: Platform,
  sinceIso: string,
  maxResults: number,
  token: string,
): Promise<{ videos: NormalizedVideo[]; rawCount: number; costUsd: number | null; status: number }> {
  const actorId = backfillActorId(platform);
  const profileUrl = profileUrlFor(platform);
  if (!actorId || !profileUrl) return { videos: [], rawCount: 0, costUsd: 0, status: 0 };
  const built = buildInputCandidates(platform, actorId, "discover", {
    profileUrl,
    sinceIso,
    limit: maxResults,
  })[0];
  if (!built) return { videos: [], rawCount: 0, costUsd: 0, status: 0 };

  const res = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/run-sync-get-dataset-items?clean=true`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(built.input),
      signal: AbortSignal.timeout(APIFY_RUN_TIMEOUT_MS),
    },
  );
  let items: unknown[] = [];
  try {
    const json = await res.json();
    items = Array.isArray(json) ? json : [];
  } catch {
    items = [];
  }
  const videos = items
    .map((it) => {
      const raw = it as Record<string, unknown>;
      const n = normalizeVideoItem(raw, platform);
      return n && isLikelyVideoItem(raw, platform) ? n : null;
    })
    .filter((v): v is NormalizedVideo => v !== null);

  // Best-effort actual cost: the most recent run for this actor (the one we just
  // triggered). Never throws — cost is reported as null if unavailable.
  let costUsd: number | null = null;
  try {
    const r = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?desc=true&limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const d = (await r.json()) as { data?: { items?: Array<{ usageTotalUsd?: number }> } };
    costUsd = d.data?.items?.[0]?.usageTotalUsd ?? null;
  } catch {
    costUsd = null;
  }
  return { videos, rawCount: items.length, costUsd, status: res.status };
}

/**
 * Build the Bootcamp backfill DRY-RUN report. READ-ONLY: enumerates the
 * back-catalog per platform via the configured provider, classifies each
 * candidate against existing records, and reports — NEVER writes a video.
 * Enforces the hard caps (provider calls, cost, per-platform results) + the
 * date floor. Disabled unless cfg.enabled && cfg.provider !== "none".
 */
export async function runBackfillDryRun(
  store: Store,
  cfg: BackfillConfig,
  deps: { now?: Date } = {},
): Promise<BackfillDryRunReport> {
  const now = deps.now ?? new Date();
  const startMs = etMidnightMs(cfg.startDate);
  const mtlStartMs = campaignStartMs();
  const token = getApifyToken();

  const lookupExisting = async (platform: Platform, canonicalUrl: string | null, externalVideoId: string | null) => {
    if (!canonicalUrl && !externalVideoId) return null;
    const v: Video | null = await store.findVideoByUrlOrExternalId(platform, canonicalUrl ?? "", externalVideoId);
    if (!v) return null;
    return { videoId: v.id, campaign: videoCampaign(v), excluded: isAdminExcluded(v) };
  };

  // Hard cap: each platform costs ONE provider unit. Pre-allocate the budget by
  // platform order BEFORE the parallel fan-out so a low maxProviderCalls is
  // enforced deterministically (a shared mutable counter would race under
  // Promise.all — every platform would read it > 0 before any decrement).
  const buildPlatform = async (platform: Platform, allowed: boolean): Promise<BackfillPlatformReport> => {
    const byClass = emptyByClass();
    const candidates: BackfillCandidate[] = [];
    const notes: string[] = [];
    let provider: "apify" | "youtube_api" | "none" = "none";
    let ran = false;
    let providerCalls = 0;
    let estCostUsd: number | null = 0;
    let stopReason: StopReason = "complete";
    let videos: NormalizedVideo[] = [];

    if (platform === "youtube") {
      provider = "youtube_api";
      if (!getYouTubeApiKey()) {
        notes.push("YouTube Data API key not configured — cannot enumerate.");
        return platformReport(platform, provider, false, [], byClass, candidates, 0, null, "not_configured", notes);
      }
      const profile = (await store.listProfiles()).find((p) => p.platform === "youtube") ?? null;
      if (!profile) {
        notes.push("No YouTube profile configured.");
        return platformReport(platform, provider, false, [], byClass, candidates, 0, null, "not_configured", notes);
      }
      if (!allowed) {
        return platformReport(platform, provider, false, [], byClass, candidates, 0, 0, "max_calls", ["Provider-call cap reached before YouTube."]);
      }
      const maxPages = 8;
      try {
        videos = await new YouTubeApiProvider().listRecentUploads(profile, new Date(startMs), maxPages);
        providerCalls = maxPages; // playlistItems pages (free quota)
        ran = true;
        estCostUsd = 0; // free quota
        notes.push(`YouTube uploads enumerated from ${cfg.startDate} forward (free Data API).`);
      } catch {
        stopReason = "error";
        notes.push("YouTube enumeration failed.");
      }
    } else {
      // TikTok / Instagram / Facebook → Apify (the paginating provider).
      provider = cfg.provider === "apify" ? "apify" : "none";
      if (cfg.provider !== "apify") {
        notes.push("Backfill provider is not Apify — SocialCrawl can't paginate this platform's back-catalog.");
        return platformReport(platform, "none", false, [], byClass, candidates, 0, null, "disabled", notes);
      }
      if (!token) {
        notes.push("APIFY_TOKEN not configured — cannot run the backfill actor.");
        return platformReport(platform, provider, false, [], byClass, candidates, 0, null, "not_configured", notes);
      }
      if (!allowed) {
        return platformReport(platform, provider, false, [], byClass, candidates, 0, 0, "max_calls", ["Provider-call cap reached before this platform."]);
      }
      try {
        const r = await enumerateApify(platform, cfg.startDate, MAX_RESULTS_PER_PLATFORM, token);
        videos = r.videos;
        providerCalls = 1;
        ran = true;
        estCostUsd = r.costUsd;
        if (r.videos.length >= MAX_RESULTS_PER_PLATFORM) {
          stopReason = "max_results";
          notes.push(`Hit the per-platform results ceiling (${MAX_RESULTS_PER_PLATFORM}).`);
        } else {
          stopReason = "reached_start_date";
        }
        if (cfg.maxCostUsd && r.costUsd !== null && r.costUsd > cfg.maxCostUsd) {
          notes.push(`This platform's cost $${r.costUsd.toFixed(4)} exceeded the cap $${cfg.maxCostUsd}.`);
        }
      } catch (e) {
        stopReason = "error";
        notes.push(`Apify enumeration failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
      }
    }

    // Classify each enumerated candidate (newest→oldest), deduped, against existing.
    const seen = new Set<string>();
    const dated: string[] = [];
    let anchorFound = false;
    for (const n of videos) {
      const parsed = n.originalUrl ? parseVideoUrl(n.originalUrl) : null;
      const externalVideoId = n.externalVideoId ?? parsed?.externalVideoId ?? null;
      const canonicalUrl = n.originalUrl ?? parsed?.canonicalUrl ?? null;
      const key = `${platform}:${externalVideoId ?? canonicalUrl ?? Math.random()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (externalVideoId === ANCHOR_ID[platform] || (canonicalUrl ?? "").includes(ANCHOR_ID[platform])) anchorFound = true;
      if (n.publishedAt) dated.push(n.publishedAt.slice(0, 10));
      const existing = await lookupExisting(platform, canonicalUrl, externalVideoId);
      const { classification, reason } = classifyCandidate({
        parsed,
        publishedAt: n.publishedAt,
        existing,
        bootcampStartMs: startMs,
        mtlStartMs,
        source: "youtube", // enumerated (resolved) — has a real date
      });
      byClass[classification]++;
      if (candidates.length < MAX_DISPLAY) {
        candidates.push({
          url: n.originalUrl,
          canonicalUrl,
          platform,
          externalVideoId,
          publishedAt: n.publishedAt,
          title: n.title,
          caption: n.caption,
          thumbnailUrl: n.thumbnailUrl,
          views: n.views,
          classification,
          reason,
          suggestedCampaign:
            classification === "suggested_bootcamp"
              ? "bootcamp"
              : classification === "overlap"
                ? null
                : null,
          existingVideoId: existing?.videoId ?? null,
        });
      }
    }
    dated.sort();
    const rep = platformReport(platform, provider, ran, dated, byClass, candidates, providerCalls, estCostUsd, stopReason, notes);
    rep.anchorFound = ran ? anchorFound : null;
    // A date-floored scrape that returns items necessarily paginated back to the
    // start window (the provider stops at the floor); reaching the anchor or an
    // oldest date within ~30 days of the floor confirms full back-catalog depth.
    rep.canPaginate = ran
      ? dated.length > 0 && (anchorFound || new Date(dated[0]).getTime() <= startMs + 30 * 86_400_000)
      : null;
    return rep;
  };

  // PRE-SPEND cost-cap guard: estimate the worst-case Apify cost (1 unit per
  // allowed SocialCrawl-platform run × a conservative per-run ceiling) and ABORT
  // before any provider call if it would exceed maxCostUsd. This makes the cost
  // cap actually preventive (not just advisory) despite the parallel fan-out.
  const allowedApifyRuns =
    cfg.provider === "apify"
      ? BACKFILL_PLATFORMS.filter((p, i) => p !== "youtube" && i < cfg.maxProviderCalls).length
      : 0;
  if (cfg.maxCostUsd > 0 && allowedApifyRuns * ESTIMATED_APIFY_RUN_COST_USD > cfg.maxCostUsd) {
    const note = `Estimated worst-case cost ~$${(allowedApifyRuns * ESTIMATED_APIFY_RUN_COST_USD).toFixed(2)} (${allowedApifyRuns} Apify run(s)) exceeds the $${cfg.maxCostUsd} cap — aborted before any provider call. Raise BACKFILL_MAX_COST_USD or lower maxProviderCalls.`;
    const platforms = BACKFILL_PLATFORMS.map((p) =>
      platformReport(
        p,
        p === "youtube" ? "youtube_api" : "apify",
        false,
        [],
        emptyByClass(),
        [],
        0,
        0,
        "max_cost",
        [note],
      ),
    );
    return {
      generatedAt: now.toISOString(),
      enabled: cfg.enabled,
      provider: cfg.provider,
      startDate: cfg.startDate,
      platforms,
      totals: { candidatesFound: 0, importable: 0, suggestedBootcamp: 0, overlap: 0, alreadyMtl: 0, alreadyBootcamp: 0, alreadyExcluded: 0, invalid: 0, providerCalls: 0, estCostUsd: 0 },
      maxProviderCalls: cfg.maxProviderCalls,
      maxCostUsd: cfg.maxCostUsd,
      wroteRecords: false,
    };
  }

  // Enumerate platforms in parallel (each is independent; wall-clock ≈ the
  // slowest single platform, under the function timeout). Call budget is
  // pre-allocated by platform order so a low maxProviderCalls is enforced
  // race-free — platform i runs only if i < maxProviderCalls.
  const platforms = await Promise.all(
    BACKFILL_PLATFORMS.map((p, i) => buildPlatform(p, i < cfg.maxProviderCalls)),
  );

  const sum = (sel: (r: BackfillPlatformReport) => number) => platforms.reduce((s, r) => s + sel(r), 0);
  const cls = (c: CandidateClass) => sum((r) => r.byClass[c]);
  // Totals derived from the resolved reports (race-free): one provider unit per
  // platform that actually ran; cost = sum of known per-platform costs.
  const ranUnits = platforms.filter((r) => r.ran).length;
  const costs = platforms.map((r) => r.estCostUsd).filter((c): c is number => c !== null);
  const totalCostUsd = costs.length > 0 ? Math.round(costs.reduce((s, c) => s + c, 0) * 10000) / 10000 : null;
  return {
    generatedAt: now.toISOString(),
    enabled: cfg.enabled,
    provider: cfg.provider,
    startDate: cfg.startDate,
    platforms,
    totals: {
      candidatesFound: sum((r) => r.candidatesFound),
      importable: [...IMPORTABLE].reduce((s, c) => s + cls(c), 0),
      suggestedBootcamp: cls("suggested_bootcamp"),
      overlap: cls("overlap"),
      alreadyMtl: cls("already_mtl"),
      alreadyBootcamp: cls("already_bootcamp"),
      alreadyExcluded: cls("already_excluded"),
      invalid: cls("invalid_url") + cls("invalid_date"),
      providerCalls: ranUnits,
      estCostUsd: totalCostUsd,
    },
    maxProviderCalls: cfg.maxProviderCalls,
    maxCostUsd: cfg.maxCostUsd,
    wroteRecords: false,
  };
}

function platformReport(
  platform: Platform,
  provider: "apify" | "youtube_api" | "none",
  ran: boolean,
  dated: string[],
  byClass: Record<CandidateClass, number>,
  candidates: BackfillCandidate[],
  providerCalls: number,
  estCostUsd: number | null,
  stopReason: StopReason,
  notes: string[],
): BackfillPlatformReport {
  return {
    platform,
    provider,
    ran,
    canPaginate: null,
    candidatesFound: Object.values(byClass).reduce((s, n) => s + n, 0),
    earliest: dated[0] ?? null,
    latest: dated[dated.length - 1] ?? null,
    anchorFound: null,
    byClass,
    alreadyTracked: byClass.already_mtl + byClass.already_bootcamp + byClass.already_unassigned + byClass.already_excluded,
    estCostUsd,
    providerCalls,
    stopReason,
    candidates,
    notes,
  };
}

export { CANDIDATE_CLASS_LABEL };
