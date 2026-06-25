// POST /api/admin/bootcamp-backfill/import — APPROVE → WRITE the selected
// backfill candidates. Admin session OR CRON_SECRET bearer (shared fail-closed
// guard). Two modes: { preview: true } returns the credit/campaign confirmation
// summary WITHOUT writing; { confirm: true } writes the records. Initial metrics
// use the ONGOING provider (SocialCrawl TT/IG/FB, YouTube Data API) within the
// daily cap headroom — NEVER Apify, never on cron. Manual assignment is the
// source of truth (already-MTL not overwritten, excluded not re-added, no dupes).

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { ensureSeedData } from "@/lib/seed";
import { resolveProvider } from "@/lib/providers/registry";
import { getSocialcrawlDailyCreditCap } from "@/lib/config";
import { getRefreshPolicyConfig } from "@/lib/refresh-policy";
import { summarizeCredits, isSocialcrawlPlatform } from "@/lib/credit-policy";
import { importBackfillCandidates, parseImportCandidates, type ImportCandidate } from "@/lib/backfill-import";
import type { Platform } from "@/lib/types";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Credits reserved for the ongoing 15-min sweep so an import never starves it. */
const IMPORT_CREDIT_RESERVE = 20;

function summarizeSelection(cands: ImportCandidate[]) {
  const byAssignment = { bootcamp: 0, mtl: 0, unassigned: 0, exclude: 0, ignore: 0 } as Record<string, number>;
  const byPlatform: Record<string, number> = {};
  let newBillableMetrics = 0; // new TT/IG/FB getting initial metrics (1 credit each)
  for (const c of cands) {
    byAssignment[c.assignment] = (byAssignment[c.assignment] ?? 0) + 1;
    byPlatform[c.platform] = (byPlatform[c.platform] ?? 0) + 1;
    if ((c.assignment === "bootcamp" || c.assignment === "mtl") && isSocialcrawlPlatform(c.platform)) {
      newBillableMetrics++; // upper bound (existing/dupes resolve to fewer at write time)
    }
  }
  return { selected: cands.length, byAssignment, byPlatform, estInitialMetricsCredits: newBillableMetrics };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await readJsonObject(req)) ?? {};
    const candidates = parseImportCandidates(body.candidates);
    if (candidates.length === 0) return NextResponse.json({ ok: false, error: "No valid candidates selected" }, { status: 400 });
    if (candidates.length > 500) return NextResponse.json({ ok: false, error: "Too many candidates (max 500 per import)" }, { status: 400 });

    const store = getStore();
    const cfg = getRefreshPolicyConfig();
    const attempts = await store.listCollectionAttempts(4000);
    const cap = getSocialcrawlDailyCreditCap();
    const credits = summarizeCredits({ attempts, now: new Date(), tz: cfg.quietTimezone, cap, activeStartHour: cfg.quietStartHour, activeEndHour: cfg.quietEndHour });
    const headroom = Math.max(0, credits.headroomToday - IMPORT_CREDIT_RESERVE);
    const sel = summarizeSelection(candidates);

    // ── Preview (no write): the credit + campaign confirmation summary ───────
    if (body.preview === true && body.confirm !== true) {
      return NextResponse.json({
        ok: true,
        preview: true,
        ...sel,
        cap,
        usedToday: credits.usedToday,
        headroom,
        remaining: credits.remaining,
        estDaysRemaining: credits.estDaysRemaining,
        estApifyUsd: 0, // discovery already ran; write never calls Apify
        estBootcampDailyRefreshCost: sel.byAssignment.bootcamp, // ~1 SC credit/SC-bootcamp-video/day
        projectedToday: credits.projectedToday,
        fitsUnderCap: sel.estInitialMetricsCredits <= headroom,
        pendingIfImportedNow: Math.max(0, sel.estInitialMetricsCredits - headroom),
        message:
          "Initial metrics are fetched within today's cap; the rest are marked pending and the daily Bootcamp tier fetches them automatically. No Apify is used by the write step.",
      });
    }

    if (body.confirm !== true) {
      return NextResponse.json({ ok: false, error: "Pass { confirm: true } to write, or { preview: true } to preview." }, { status: 400 });
    }

    // ── Write ────────────────────────────────────────────────────────────────
    const campaign = await ensureSeedData(store);
    const resolveMetrics = async (platform: Platform, url: string) => {
      // apifyAllowedOverride=false is the HARD, fail-closed no-Apify guarantee:
      // SocialCrawl/YouTube only. If SocialCrawl isn't the selected provider, this
      // returns ManualProvider (getVideoMetadata → null), NEVER a bare Apify run.
      const { provider, readiness } = await resolveProvider(platform, store, false);
      if (!readiness.ready) return null;
      try {
        return await provider.getVideoMetadata(url);
      } catch {
        return null;
      }
    };
    const result = await importBackfillCandidates(store, campaign.id, candidates, { resolveMetrics, scHeadroom: headroom });
    return NextResponse.json({
      ok: true,
      result,
      nextBootcampRefreshNote: "Bootcamp videos refresh once per day; pending metrics are fetched by the daily tier within ~24h, under the cap.",
    });
  } catch (e) {
    return serverError(e, "Backfill import failed");
  }
}
