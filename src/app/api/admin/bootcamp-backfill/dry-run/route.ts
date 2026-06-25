// POST /api/admin/bootcamp-backfill/dry-run — one-time Bootcamp BACKFILL
// discovery DRY RUN. Admin session OR CRON_SECRET bearer (constant-time,
// fail-closed). NEVER on cron, NEVER part of ongoing refresh. Runs the
// paginating provider (Apify for TikTok/Instagram/Facebook; YouTube Data API
// for Shorts) ONLY when explicitly opted in for this call — `confirm:true` +
// provider, or the BACKFILL_DISCOVERY_ENABLED env. Hard caps + date floor.
// NEVER writes a video (the approve/write step is a separate, later route).

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { getBackfillConfig, getBootcampStartDateEt, type BackfillConfig } from "@/lib/config";
import { runBackfillDryRun } from "@/lib/backfill";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Effective backfill config = env defaults, with EXPLICIT per-run overrides from
 *  the admin request (so a one-off dry run never needs a persistent env flip).
 *  Apify still only runs when the caller explicitly opts in (confirm + provider)
 *  or the env enables it — never implicitly, never on cron. Caps are clamped. */
function effectiveConfig(base: BackfillConfig, body: Record<string, unknown>): BackfillConfig {
  const wantApify = body.provider === "apify";
  const confirmed = body.confirm === true || body.enable === true;
  const num = (v: unknown, fallback: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
  };
  // Date floor is HARD: a request may only TIGHTEN the window (a later start),
  // never push it earlier than the configured Bootcamp floor (no pre-April scrape).
  const floor = getBootcampStartDateEt();
  const reqStart = typeof body.startDate === "string" && DATE_RE.test(body.startDate) ? body.startDate : base.startDate;
  return {
    enabled: base.enabled || confirmed,
    provider: wantApify ? "apify" : base.provider,
    maxProviderCalls: num(body.maxProviderCalls, base.maxProviderCalls, 20),
    maxCostUsd: num(body.maxCostUsd, base.maxCostUsd, 25),
    startDate: reqStart < floor ? floor : reqStart,
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await readJsonObject(req)) ?? {};
    const cfg = effectiveConfig(getBackfillConfig(), body);
    if (!cfg.enabled || cfg.provider === "none") {
      return NextResponse.json({
        ok: true,
        disabled: true,
        message:
          "Backfill is off. Trigger it explicitly (provider=apify, confirm=true) or set BACKFILL_DISCOVERY_ENABLED=true + BACKFILL_DISCOVERY_PROVIDER=apify. This dry run never writes records and never re-enables ongoing Apify.",
        config: { provider: cfg.provider, maxProviderCalls: cfg.maxProviderCalls, maxCostUsd: cfg.maxCostUsd, startDate: cfg.startDate },
      });
    }
    const report = await runBackfillDryRun(getStore(), cfg);
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return serverError(e, "Backfill dry run failed");
  }
}
