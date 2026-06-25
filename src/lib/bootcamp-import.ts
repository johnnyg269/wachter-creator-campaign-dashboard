// Bootcamp import (Phase 2) — config + DRY RUN only. The write/approve step
// lands in Phase 2B. The campaigns overlap (Bootcamp started months before MTL
// and is still posting), so date NEVER auto-assigns a campaign: the dry run only
// SUGGESTS, and manual admin assignment remains the source of truth.
//
// Enumeration reality (probed 2026-06-25): SocialCrawl profile endpoints return
// only the ~10 most recent posts and do NOT paginate, so the April–May back-
// catalog cannot be crawled for TikTok/Instagram/Facebook. Those are imported by
// pasted URL (resolved individually, 1 credit each). YouTube's Data API uploads
// playlist DOES paginate (free quota), so YouTube Shorts auto-enumerate from the
// start date forward. The anchor URLs are always resolved + included.

import { campaignStartMs, etMidnightMs } from "./eligibility";
import { isAdminExcluded, videoCampaign, type CampaignSlug } from "./campaigns";
import { parseVideoUrl, type ParsedVideoUrl } from "./url-parse";
import type { NormalizedVideo, Platform, Video } from "./types";
import type { Store } from "./store/types";
import type { CreditAttempt } from "./credit-policy";
import { getSocialcrawlDailyCreditCap } from "./config";
import { socialcrawlCreditsToday } from "./refresh-policy";
import { socialcrawlCreditsRemaining, isSocialcrawlPlatform } from "./credit-policy";

export const IMPORT_PLATFORMS: readonly Platform[] = ["tiktok", "instagram", "facebook", "youtube"];

/** Required Bootcamp start date + first-video anchors (spec defaults; override
 *  via env without a code change, then admin can adjust per run). */
export const BOOTCAMP_DEFAULTS = {
  startDate: "2026-04-11",
  anchors: {
    tiktok: "https://www.tiktok.com/@cybernick0x/video/7627682544586083614",
    youtube: "https://www.youtube.com/shorts/uAH54si-VJ8",
    facebook: "https://www.facebook.com/reel/826026589994871",
    instagram: "https://www.instagram.com/reel/DXA4QZtDKMC/?igsh=anlhb3ZicGE1cmJl",
  } as Record<Platform, string>,
} as const;

const ANCHOR_ENV: Record<Platform, string> = {
  tiktok: "BOOTCAMP_ANCHOR_TIKTOK",
  instagram: "BOOTCAMP_ANCHOR_INSTAGRAM",
  facebook: "BOOTCAMP_ANCHOR_FACEBOOK",
  youtube: "BOOTCAMP_ANCHOR_YOUTUBE",
};

function envStr(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

export interface BootcampPlatformConfig {
  platform: Platform;
  /** Earliest allowed publish date (YYYY-MM-DD ET), required. */
  startDate: string;
  /** First Bootcamp video anchor URL (strongly preferred), optional. */
  anchorUrl: string | null;
  /** Admin-pasted back-catalog URLs (newline/CSV) for this platform. */
  pastedUrls: string[];
  /** Optional safety caps (blank by default). */
  maxCandidates: number | null;
  maxPages: number | null;
  /** Optional hard upper date bound — blank by default (Bootcamp has no end). */
  safetyStopDate: string | null;
}

export interface BootcampImportConfig {
  /** Campaign-level start-date default (applied to every platform unless
   *  per-platform override is set). */
  startDate: string;
  platforms: Record<Platform, BootcampPlatformConfig>;
  /** Default import mode is review-first; never auto-assign everything. */
  mode: "review";
}

/** Env/spec defaults, pre-filled for the admin form. */
export function getBootcampImportDefaults(): BootcampImportConfig {
  const startDate = envStr("BOOTCAMP_START_DATE") ?? BOOTCAMP_DEFAULTS.startDate;
  const platforms = {} as Record<Platform, BootcampPlatformConfig>;
  for (const p of IMPORT_PLATFORMS) {
    platforms[p] = {
      platform: p,
      startDate,
      anchorUrl: envStr(ANCHOR_ENV[p]) ?? BOOTCAMP_DEFAULTS.anchors[p] ?? null,
      pastedUrls: [],
      maxCandidates: null,
      maxPages: null,
      safetyStopDate: null,
    };
  }
  return { startDate, platforms, mode: "review" };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse newline/CSV/space-separated pasted text into unique http(s) URLs. */
export function extractUrls(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of text.split(/[\s,]+/)) {
    const u = tok.trim();
    if (!u || !/^https?:\/\//i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Validate + normalize an admin-submitted config object into a safe
 *  BootcampImportConfig (falls back to defaults for missing/invalid fields). */
export function parseImportConfig(body: unknown): BootcampImportConfig {
  const defaults = getBootcampImportDefaults();
  if (!body || typeof body !== "object") return defaults;
  const b = body as Record<string, unknown>;
  const topStart = typeof b.startDate === "string" && DATE_RE.test(b.startDate) ? b.startDate : defaults.startDate;
  const inPlatforms = (b.platforms && typeof b.platforms === "object" ? b.platforms : {}) as Record<string, unknown>;
  const platforms = {} as Record<Platform, BootcampPlatformConfig>;
  for (const p of IMPORT_PLATFORMS) {
    const raw = (inPlatforms[p] && typeof inPlatforms[p] === "object" ? inPlatforms[p] : {}) as Record<string, unknown>;
    const startDate = typeof raw.startDate === "string" && DATE_RE.test(raw.startDate) ? raw.startDate : topStart;
    const anchorUrl =
      typeof raw.anchorUrl === "string"
        ? raw.anchorUrl.trim() || null
        : defaults.platforms[p].anchorUrl;
    const pasted = extractUrls(
      typeof raw.pastedUrls === "string"
        ? raw.pastedUrls
        : Array.isArray(raw.pastedUrls)
          ? raw.pastedUrls.join("\n")
          : "",
    );
    const posInt = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    };
    platforms[p] = {
      platform: p,
      startDate,
      anchorUrl,
      pastedUrls: pasted,
      maxCandidates: posInt(raw.maxCandidates),
      maxPages: posInt(raw.maxPages),
      safetyStopDate: typeof raw.safetyStopDate === "string" && DATE_RE.test(raw.safetyStopDate) ? raw.safetyStopDate : null,
    };
  }
  return { startDate: topStart, platforms, mode: "review" };
}

// ── Candidate classification (pure) ─────────────────────────────────────────

export type CandidateClass =
  | "suggested_bootcamp"
  | "suggested_bootcamp_unresolved"
  | "overlap"
  | "before_start"
  | "invalid_date"
  | "invalid_url"
  | "already_mtl"
  | "already_bootcamp"
  | "already_unassigned"
  | "already_excluded";

export type CandidateSource = "anchor" | "pasted" | "youtube";

export interface ExistingMatch {
  videoId: string;
  campaign: CampaignSlug | null;
  excluded: boolean;
}

export const CANDIDATE_CLASS_LABEL: Record<CandidateClass, string> = {
  suggested_bootcamp: "Suggested Bootcamp",
  suggested_bootcamp_unresolved: "Suggested Bootcamp (date verified on import)",
  overlap: "Overlap — manual review",
  before_start: "Skipped — before start date",
  invalid_date: "Review — missing/invalid date",
  invalid_url: "Skipped — invalid URL",
  already_mtl: "Already MTL — not overwritten",
  already_bootcamp: "Already Bootcamp — duplicate",
  already_unassigned: "Already tracked — unassigned",
  already_excluded: "Removed from tracking — skipped",
};

/**
 * Classify one candidate. Manual assignment is the source of truth, so existing
 * assignments are NEVER overwritten and removed videos are NEVER re-added; new
 * candidates are only ever SUGGESTED (overlap with the MTL window → review).
 */
export function classifyCandidate(args: {
  parsed: ParsedVideoUrl | null;
  publishedAt: string | null;
  existing: ExistingMatch | null;
  bootcampStartMs: number;
  mtlStartMs: number;
  source: CandidateSource;
}): { classification: CandidateClass; reason: string } {
  const { parsed, publishedAt, existing, bootcampStartMs, mtlStartMs, source } = args;

  if (!parsed || !parsed.externalVideoId) {
    return { classification: "invalid_url", reason: "Could not parse a video id from the URL" };
  }
  if (existing) {
    if (existing.excluded)
      return { classification: "already_excluded", reason: "Previously removed from tracking — not re-added" };
    if (existing.campaign === "mtl")
      return { classification: "already_mtl", reason: "Already assigned to MTL — manual assignment preserved" };
    if (existing.campaign === "bootcamp")
      return { classification: "already_bootcamp", reason: "Already assigned to Bootcamp — duplicate" };
    return { classification: "already_unassigned", reason: "Already tracked (unassigned) — assign manually" };
  }

  if (publishedAt === null) {
    // Unresolved pasted TT/IG/FB URL — date verified when resolved on import.
    return {
      classification: "suggested_bootcamp_unresolved",
      reason: source === "pasted" ? "Pasted URL — publish date confirmed on import" : "No publish date available",
    };
  }
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t) || new Date(t).getUTCFullYear() < 2005) {
    return { classification: "invalid_date", reason: "Missing/invalid publish date — needs review" };
  }
  if (t < bootcampStartMs) {
    return { classification: "before_start", reason: "Published before the Bootcamp start date" };
  }
  if (t >= mtlStartMs) {
    return {
      classification: "overlap",
      reason: "Published within the MTL window — overlap, assign manually",
    };
  }
  return { classification: "suggested_bootcamp", reason: "Published in the Bootcamp-only window" };
}

// ── Dry run orchestration ───────────────────────────────────────────────────

export interface BootcampCandidate {
  url: string;
  canonicalUrl: string | null;
  platform: Platform | null;
  externalVideoId: string | null;
  publishedAt: string | null;
  title: string | null;
  source: CandidateSource;
  classification: CandidateClass;
  reason: string;
  existingVideoId: string | null;
}

export interface BootcampPlatformReport {
  platform: Platform;
  startDate: string;
  anchorUrl: string | null;
  anchorResolved: boolean | null;
  anchorIncludedAsCandidate: boolean;
  candidatesFound: number;
  byClass: Record<CandidateClass, number>;
  /** SocialCrawl credits to import the importable candidates (1cr/video; the
   *  resolve call also returns initial metrics + thumbnail, no extra credit). */
  estSocialcrawlCredits: number;
  /** YouTube Data API calls for enumeration + import (free quota). */
  estYoutubeCalls: number;
  candidates: BootcampCandidate[];
  notes: string[];
}

export interface BootcampDryRunReport {
  generatedAt: string;
  startDate: string;
  platforms: BootcampPlatformReport[];
  totals: {
    candidatesFound: number;
    importable: number;
    suggestedBootcamp: number;
    overlap: number;
    alreadyMtl: number;
    alreadyBootcamp: number;
    alreadyExcluded: number;
    beforeStart: number;
    invalid: number;
    estSocialcrawlCredits: number;
    estYoutubeCalls: number;
  };
  creditCap: number;
  usedToday: number;
  headroomToday: number;
  remainingTotal: number | null;
  fitsUnderTodayCap: boolean;
  fitsUnderRemainingTotal: boolean | null;
}

/** What the dry run needs from a (platform-bound) provider. Injectable for tests. */
export interface BootcampProviderAdapter {
  /** Resolve one video URL (1 SocialCrawl credit; free on YouTube). */
  getVideoMetadata(url: string): Promise<NormalizedVideo | null>;
  /** YouTube only: page the uploads playlist for videos on/after `since`
   *  (free quota). Absent for SocialCrawl platforms (no back-catalog crawl). */
  listRecentUploads?(since: Date, maxPages: number): Promise<NormalizedVideo[]>;
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
  "suggested_bootcamp_unresolved",
  "overlap",
  "invalid_date",
]);

const MAX_DISPLAY_CANDIDATES = 60;

/**
 * Build the Bootcamp import dry-run report. READ-ONLY: resolves the anchors
 * (1 credit each on TikTok/Instagram/Facebook; free on YouTube) and enumerates
 * YouTube uploads (free); pasted TT/IG/FB URLs are parsed + deduped + checked
 * against existing records WITHOUT resolving (no credit), with their import cost
 * ESTIMATED. Never writes a video.
 */
export async function runBootcampDryRun(
  store: Store,
  config: BootcampImportConfig,
  deps: {
    now?: Date;
    getProvider: (platform: Platform) => Promise<BootcampProviderAdapter | null>;
    attempts?: CreditAttempt[];
  },
): Promise<BootcampDryRunReport> {
  const now = deps.now ?? new Date();
  const bootcampDefaultMs = etMidnightMs(config.startDate);
  const mtlStartMs = campaignStartMs();
  const attempts = deps.attempts ?? [];

  const lookupExisting = async (
    platform: Platform,
    canonicalUrl: string | null,
    externalVideoId: string | null,
  ): Promise<ExistingMatch | null> => {
    if (!canonicalUrl && !externalVideoId) return null;
    const v: Video | null = await store.findVideoByUrlOrExternalId(
      platform,
      canonicalUrl ?? "",
      externalVideoId,
    );
    if (!v) return null;
    return { videoId: v.id, campaign: videoCampaign(v), excluded: isAdminExcluded(v) };
  };

  const platformReports: BootcampPlatformReport[] = [];

  for (const platform of IMPORT_PLATFORMS) {
    const pcfg = config.platforms[platform];
    const startMs = etMidnightMs(pcfg.startDate || config.startDate) || bootcampDefaultMs;
    const provider = await deps.getProvider(platform).catch(() => null);
    const notes: string[] = [];
    const byClass = emptyByClass();
    const candidates: BootcampCandidate[] = [];
    const seen = new Set<string>(); // dedupe key (externalVideoId|canonicalUrl)
    let anchorResolved: boolean | null = pcfg.anchorUrl ? false : null;
    let anchorIncluded = false;
    let estSc = 0;
    let estYt = 0;

    const dedupeKey = (parsed: ParsedVideoUrl | null, url: string) =>
      `${platform}:${parsed?.externalVideoId ?? parsed?.canonicalUrl ?? url}`;

    const addCandidate = async (
      url: string,
      source: CandidateSource,
      resolved: NormalizedVideo | null,
      publishedAtKnown: string | null,
    ) => {
      const parsed = parseVideoUrl(url);
      const key = dedupeKey(parsed, url);
      if (seen.has(key)) return false;
      seen.add(key);
      const canonicalUrl = resolved?.originalUrl ?? parsed?.canonicalUrl ?? null;
      const externalVideoId = resolved?.externalVideoId ?? parsed?.externalVideoId ?? null;
      const existing = await lookupExisting(platform, canonicalUrl, externalVideoId);
      const publishedAt = resolved?.publishedAt ?? publishedAtKnown ?? null;
      const { classification, reason } = classifyCandidate({
        parsed,
        publishedAt,
        existing,
        bootcampStartMs: startMs,
        mtlStartMs,
        source,
      });
      byClass[classification]++;
      if (candidates.length < MAX_DISPLAY_CANDIDATES) {
        candidates.push({
          url,
          canonicalUrl,
          platform: parsed?.platform ?? null,
          externalVideoId,
          publishedAt,
          title: resolved?.title ?? null,
          source,
          classification,
          reason,
          existingVideoId: existing?.videoId ?? null,
        });
      }
      // Import cost: importable, not-yet-tracked candidates only.
      if (IMPORTABLE.has(classification)) {
        if (isSocialcrawlPlatform(platform)) estSc++;
        else estYt++; // youtube import = free quota
      }
      return true;
    };

    // 1) Anchor — always resolved (1cr on SC; free on YouTube) + included.
    if (pcfg.anchorUrl) {
      let resolved: NormalizedVideo | null = null;
      if (provider) {
        try {
          resolved = await provider.getVideoMetadata(pcfg.anchorUrl);
        } catch {
          resolved = null;
        }
      }
      anchorResolved = Boolean(resolved);
      anchorIncluded = await addCandidate(pcfg.anchorUrl, "anchor", resolved, null);
      if (!anchorResolved) notes.push("Anchor did not resolve — check the URL or provider availability.");
    }

    // 2) YouTube: auto-enumerate uploads from the start date forward (free).
    if (platform === "youtube" && provider?.listRecentUploads) {
      const maxPages = pcfg.maxPages ?? 6;
      try {
        const uploads = await provider.listRecentUploads(new Date(startMs), maxPages);
        estYt += maxPages; // playlistItems pages (free quota)
        let added = 0;
        for (const u of uploads) {
          if (pcfg.maxCandidates && added >= pcfg.maxCandidates) {
            notes.push(`Stopped at maxCandidates=${pcfg.maxCandidates}.`);
            break;
          }
          if (!u.originalUrl) continue;
          if (await addCandidate(u.originalUrl, "youtube", u, u.publishedAt)) added++;
        }
        notes.push(`YouTube uploads enumerated from ${pcfg.startDate} forward (free Data API).`);
      } catch {
        notes.push("YouTube enumeration failed — paste URLs to import manually.");
      }
    } else if (platform !== "youtube") {
      notes.push(
        "SocialCrawl lists only the ~10 most recent posts (no pagination) — paste the back-catalog URLs to import them (1 credit each, verified on import).",
      );
    }

    // 3) Pasted URLs (TT/IG/FB resolved on import, not now — no dry-run credit).
    for (const url of pcfg.pastedUrls) {
      if (pcfg.maxCandidates && candidates.length >= pcfg.maxCandidates) break;
      await addCandidate(url, "pasted", null, null);
    }

    const candidatesFound = Object.values(byClass).reduce((s, n) => s + n, 0);
    platformReports.push({
      platform,
      startDate: pcfg.startDate,
      anchorUrl: pcfg.anchorUrl,
      anchorResolved,
      anchorIncludedAsCandidate: anchorIncluded,
      candidatesFound,
      byClass,
      estSocialcrawlCredits: estSc,
      estYoutubeCalls: estYt,
      candidates,
      notes,
    });
  }

  // Totals + cap fit.
  const sum = (sel: (r: BootcampPlatformReport) => number) => platformReports.reduce((s, r) => s + sel(r), 0);
  const byClassTotal = (c: CandidateClass) => sum((r) => r.byClass[c]);
  const estSocialcrawlCredits = sum((r) => r.estSocialcrawlCredits);
  const estYoutubeCalls = sum((r) => r.estYoutubeCalls);
  const importable = sum((r) =>
    [...IMPORTABLE].reduce((s, c) => s + r.byClass[c], 0),
  );

  const cap = getSocialcrawlDailyCreditCap();
  const usedToday = socialcrawlCreditsToday(attempts, now, "America/New_York").credits;
  const headroomToday = Math.max(0, cap - usedToday);
  const remainingTotal = socialcrawlCreditsRemaining(attempts);

  return {
    generatedAt: now.toISOString(),
    startDate: config.startDate,
    platforms: platformReports,
    totals: {
      candidatesFound: sum((r) => r.candidatesFound),
      importable,
      suggestedBootcamp: byClassTotal("suggested_bootcamp") + byClassTotal("suggested_bootcamp_unresolved"),
      overlap: byClassTotal("overlap"),
      alreadyMtl: byClassTotal("already_mtl"),
      alreadyBootcamp: byClassTotal("already_bootcamp"),
      alreadyExcluded: byClassTotal("already_excluded"),
      beforeStart: byClassTotal("before_start"),
      invalid: byClassTotal("invalid_url") + byClassTotal("invalid_date"),
      estSocialcrawlCredits,
      estYoutubeCalls,
    },
    creditCap: cap,
    usedToday,
    headroomToday,
    remainingTotal,
    fitsUnderTodayCap: estSocialcrawlCredits <= headroomToday,
    fitsUnderRemainingTotal: remainingTotal === null ? null : estSocialcrawlCredits <= remainingTotal,
  };
}
