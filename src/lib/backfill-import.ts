// Bootcamp backfill APPROVE → WRITE (Phase 2B-final). Takes the admin-selected
// candidates from the review queue and creates/updates campaign-tagged records.
// Manual assignment is the source of truth: already-MTL is never overwritten
// (unless the admin EXPLICITLY reassigns it), excluded videos are never re-added,
// duplicates never create a second record. Initial metrics are fetched server-
// side (authoritative — never trusted from the client) only within the remaining
// SocialCrawl cap headroom; the rest are left "pending" for the daily tier.
// The refresh TIER is derived from campaign + age at read time (Option B), so no
// tier is stored. NEVER calls Apify (initial metrics use the ongoing provider).

import type { NormalizedVideo, Platform, Video } from "./types";
import type { Store } from "./store/types";
import {
  campaignAssignmentPatch,
  isAdminExcluded,
  trackingPatch,
  videoCampaign,
  type CampaignSlug,
} from "./campaigns";
import { engagementRate } from "./metrics";
import { initialThumbState, mergeThumbIntoRaw } from "./thumbnail-state";
import { isTikTokCdnHost } from "./thumb-proxy";
import { parseVideoUrl } from "./url-parse";

export type ImportAssignment = "bootcamp" | "mtl" | "unassigned" | "exclude" | "ignore";

export interface ImportCandidate {
  platform: Platform;
  url: string;
  externalVideoId: string | null;
  publishedAt: string | null;
  title: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  assignment: ImportAssignment;
}

export type SkipReason =
  | "already_excluded"
  | "already_assigned"
  | "invalid_url"
  | "date_missing"
  | "ignored"
  | "error";

/** A campaign-assigned record needs a valid (>=2005) date or the read-time
 *  eligibility filter would drop it from every total (date_missing). */
function hasUsableDate(iso: string | null): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && new Date(t).getUTCFullYear() >= 2005;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  excluded: number;
  assignedBootcamp: number;
  assignedMtl: number;
  assignedUnassigned: number;
  pendingMetrics: number;
  creditsUsed: number;
  skippedReasons: Record<string, number>;
  errors: string[];
}

/** Resolve current metrics for one video (authoritative). For TikTok/Instagram/
 *  Facebook this is a 1-credit SocialCrawl call; YouTube is free. Returns null on
 *  failure (the video is still created — metrics stay pending). */
export type MetricsResolver = (platform: Platform, url: string) => Promise<NormalizedVideo | null>;

const VALID_ASSIGN: ReadonlySet<string> = new Set(["bootcamp", "mtl", "unassigned", "exclude", "ignore"]);
/** SocialCrawl-billable platforms (YouTube initial metrics are free). */
const SC_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["tiktok", "instagram", "facebook"]);

export function parseImportCandidates(raw: unknown): ImportCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ImportCandidate[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const c = r as Record<string, unknown>;
    const platform = c.platform;
    const url = typeof c.url === "string" ? c.url.trim() : "";
    const assignment = typeof c.assignment === "string" ? c.assignment : "";
    if (
      (platform !== "tiktok" && platform !== "instagram" && platform !== "facebook" && platform !== "youtube") ||
      !url ||
      !VALID_ASSIGN.has(assignment)
    ) {
      continue;
    }
    out.push({
      platform,
      url,
      externalVideoId: typeof c.externalVideoId === "string" ? c.externalVideoId : null,
      publishedAt: typeof c.publishedAt === "string" ? c.publishedAt : null,
      title: typeof c.title === "string" ? c.title : null,
      caption: typeof c.caption === "string" ? c.caption : null,
      thumbnailUrl: typeof c.thumbnailUrl === "string" ? c.thumbnailUrl : null,
      assignment: assignment as ImportAssignment,
    });
  }
  return out;
}

/**
 * Write the selected backfill candidates. `scHeadroom` is the number of
 * SocialCrawl credits available for initial-metrics fetches this run (beyond it,
 * new TT/IG/FB videos are created metadata-only with metrics PENDING). Never
 * writes more than one record per video; never overwrites a non-selected
 * existing assignment; never re-adds an excluded video.
 */
export async function importBackfillCandidates(
  store: Store,
  campaignId: string,
  candidates: ImportCandidate[],
  deps: { resolveMetrics: MetricsResolver; scHeadroom: number; now?: Date },
): Promise<ImportResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  let scBudget = Math.max(0, Math.floor(deps.scHeadroom));
  const res: ImportResult = {
    created: 0, updated: 0, skipped: 0, excluded: 0,
    assignedBootcamp: 0, assignedMtl: 0, assignedUnassigned: 0,
    pendingMetrics: 0, creditsUsed: 0, skippedReasons: {}, errors: [],
  };
  const skip = (reason: SkipReason) => {
    res.skipped++;
    res.skippedReasons[reason] = (res.skippedReasons[reason] ?? 0) + 1;
  };

  for (const c of candidates) {
    try {
      if (c.assignment === "ignore") {
        skip("ignored");
        continue;
      }
      const parsed = parseVideoUrl(c.url);
      const canonicalUrl = parsed?.canonicalUrl ?? c.url;
      const externalVideoId = c.externalVideoId ?? parsed?.externalVideoId ?? null;
      if (!parsed || (!externalVideoId && !canonicalUrl)) {
        skip("invalid_url");
        continue;
      }

      const existing = await store.findVideoByUrlOrExternalId(c.platform, canonicalUrl, externalVideoId);

      // ── Existing record: manual assignment is the source of truth ──────────
      if (existing) {
        if (isAdminExcluded(existing)) {
          skip("already_excluded"); // never re-add a removed video
          continue;
        }
        if (c.assignment === "exclude") {
          await store.updateVideo(existing.id, {
            hidden: true,
            rawJson: trackingPatch(existing.rawJson, "exclude", { reason: "backfill review: removed", now: nowIso }) as Video["rawJson"],
          });
          await store.addOverride({ entityType: "video", entityId: existing.id, field: "tracking", oldValue: "active", newValue: "excluded", reason: "backfill review" });
          res.excluded++;
          continue;
        }
        const cur = videoCampaign(existing); // mtl | bootcamp | null
        const target: CampaignSlug | "unassigned" = c.assignment === "unassigned" ? "unassigned" : c.assignment;
        const curKey = cur ?? "unassigned";
        if (curKey === target) {
          skip("already_assigned"); // no duplicate, no needless overwrite
          continue;
        }
        // EXPLICIT reassignment (the admin selected a different campaign for an
        // already-tracked video — e.g. already-MTL → Bootcamp). Tag only; never
        // clobber metadata/snapshots.
        await store.updateVideo(existing.id, {
          rawJson: campaignAssignmentPatch(existing.rawJson, target) as Video["rawJson"],
        });
        await store.addOverride({ entityType: "video", entityId: existing.id, field: "campaign", oldValue: curKey, newValue: target, reason: "backfill review reassignment" });
        res.updated++;
        if (target === "bootcamp") res.assignedBootcamp++;
        else if (target === "mtl") res.assignedMtl++;
        else res.assignedUnassigned++;
        continue;
      }

      // ── New record ─────────────────────────────────────────────────────────
      if (c.assignment === "exclude") {
        // Persist a hidden+excluded record so future backfills never re-add it.
        await createRecord(store, campaignId, c, canonicalUrl, externalVideoId, "exclude", null, nowIso);
        res.excluded++;
        continue;
      }
      const slug: CampaignSlug | "unassigned" = c.assignment === "unassigned" ? "unassigned" : c.assignment;

      // Initial metrics (authoritative, server-side) within the SC cap headroom.
      // Unassigned videos don't refresh, so they don't get an initial fetch.
      let metrics: NormalizedVideo | null = null;
      const billable = SC_PLATFORMS.has(c.platform);
      const canFetch = slug !== "unassigned" && (!billable || scBudget > 0);
      if (canFetch) {
        metrics = await deps.resolveMetrics(c.platform, canonicalUrl);
        if (billable) {
          // A SocialCrawl /post resolve spends 1 credit whether or not it returns
          // an item — LOG it so socialcrawlCreditsToday() (the daily-cap basis)
          // sees this lane's spend, so a second import + the ongoing sweep can't
          // collectively overshoot the cap.
          scBudget -= 1;
          res.creditsUsed += 1;
          await store.addCollectionAttempt({
            refreshRunId: null,
            platform: c.platform,
            provider: "socialcrawl",
            actorId: null,
            kind: "detail",
            inputDescription: `socialcrawl ${c.platform} backfill-import metrics · 1cr · cache:miss`,
            success: Boolean(metrics),
            runId: null,
            itemCount: metrics ? 1 : 0,
            error: metrics ? null : "no item",
            capturedAt: nowIso,
          });
        }
      }

      // A campaign-assigned record with no usable date would be silently dropped
      // by the read-time eligibility filter (date_missing) — so it would NOT show
      // in Bootcamp/MTL/All totals despite a "created" count. Skip it honestly.
      const finalDate = metrics?.publishedAt ?? c.publishedAt;
      if ((slug === "bootcamp" || slug === "mtl") && !hasUsableDate(finalDate)) {
        skip("date_missing");
        continue;
      }

      const created = await createRecord(store, campaignId, c, canonicalUrl, externalVideoId, slug, metrics, nowIso);
      res.created++;
      if (slug === "bootcamp") res.assignedBootcamp++;
      else if (slug === "mtl") res.assignedMtl++;
      else res.assignedUnassigned++;

      if (metrics) {
        await store.addSnapshot({
          videoId: created.id,
          capturedAt: nowIso,
          views: metrics.views,
          likes: metrics.likes,
          comments: metrics.comments,
          shares: metrics.shares,
          saves: metrics.saves,
          bookmarks: metrics.bookmarks,
          engagementRate: engagementRate(metrics),
          rawJson: null,
        });
      } else if (slug !== "unassigned") {
        res.pendingMetrics++; // daily/tier refresh fetches the first reading
      }
    } catch (e) {
      res.skipped++;
      res.skippedReasons.error = (res.skippedReasons.error ?? 0) + 1;
      res.errors.push(e instanceof Error ? e.message.slice(0, 140) : "import error");
    }
  }
  return res;
}

/** Insert a new tracked video with the chosen campaign tag (or hidden+excluded).
 *  lastRefreshedAt is set only when initial metrics were fetched; otherwise null
 *  so the Option B tier fetches the first reading. */
async function createRecord(
  store: Store,
  campaignId: string,
  c: ImportCandidate,
  canonicalUrl: string,
  externalVideoId: string | null,
  assignment: CampaignSlug | "unassigned" | "exclude",
  metrics: NormalizedVideo | null,
  nowIso: string,
): Promise<Video> {
  const initThumb = initialThumbState({
    thumbnailUrl: metrics?.thumbnailUrl ?? c.thumbnailUrl,
    now: nowIso,
    verifiable: !isTikTokCdnHost(metrics?.thumbnailUrl ?? c.thumbnailUrl),
  });
  let raw: Record<string, unknown> =
    assignment === "exclude"
      ? trackingPatch({}, "exclude", { reason: "backfill review: removed", now: nowIso })
      : campaignAssignmentPatch({}, assignment);
  raw = mergeThumbIntoRaw(raw as Video["rawJson"], initThumb.thumb) as Record<string, unknown>;
  return store.insertVideo({
    campaignId,
    platform: c.platform,
    profileId: null,
    originalUrl: canonicalUrl,
    externalVideoId,
    title: metrics?.title ?? c.title,
    caption: metrics?.caption ?? c.caption,
    thumbnailUrl: initThumb.thumbnailUrl,
    publishedAt: metrics?.publishedAt ?? c.publishedAt,
    firstTrackedAt: nowIso,
    lastRefreshedAt: metrics ? nowIso : null,
    status: "active",
    episodeGroupId: null,
    sourceStatus: "live",
    errorMessage: null,
    hidden: assignment === "exclude",
    isSeed: false,
    rawJson: raw as Video["rawJson"],
  });
}
