// POST /api/admin/bootcamp-catchup — optionally set a today-only SocialCrawl
// cap override, then fill pending Bootcamp metrics within the active cap. Admin
// session OR CRON_SECRET bearer (shared fail-closed guard). SocialCrawl/YouTube
// only — NEVER Apify (resolveProvider(..., false)); NO comments, NO thumbnail
// repair, NO excluded/MTL videos. Stops at the cap; remainder stays pending.
//
//   body: { capOverride?: number, reason?: string, run?: boolean }
//   - capOverride: set today's cap (expires next ET midnight). Omit to leave it.
//   - run: default true → run the catch-up. false → only set/inspect the cap.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { resolveProvider } from "@/lib/providers/registry";
import { getRefreshPolicyConfig, socialcrawlCreditsToday } from "@/lib/refresh-policy";
import { resolveCreditCap, setCapOverride } from "@/lib/credit-cap";
import { bootcampMetricsCatchup } from "@/lib/bootcamp-catchup";
import { socialcrawlCreditsRemaining } from "@/lib/credit-policy";
import type { Platform } from "@/lib/types";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await readJsonObject(req)) ?? {};
    const store = getStore();
    const now = new Date();

    // Optional: set a today-only cap override (raise only; never below the base).
    let overrideSet = false;
    if (body.capOverride !== undefined) {
      const v = Number(body.capOverride);
      const base = (await resolveCreditCap(store, now)).baseCap;
      if (!Number.isFinite(v) || v <= 0) return NextResponse.json({ ok: false, error: "capOverride must be a positive number" }, { status: 400 });
      if (v < base) return NextResponse.json({ ok: false, error: `capOverride (${v}) must be >= the base cap (${base})` }, { status: 400 });
      await setCapOverride(store, { value: v, reason: typeof body.reason === "string" ? body.reason : undefined });
      overrideSet = true;
    }

    const resolved = await resolveCreditCap(store, now);
    const tz = getRefreshPolicyConfig().quietTimezone;
    const attempts = await store.listCollectionAttempts(4000);
    const usedTodayBefore = socialcrawlCreditsToday(attempts, now, tz).credits;
    const remaining = socialcrawlCreditsRemaining(attempts);

    const capInfo = {
      baseCap: resolved.baseCap,
      activeCap: resolved.activeCap,
      override: resolved.override, // { value, expiresAtIso, ... } or null
      usedTodayBefore,
      headroom: Math.max(0, resolved.activeCap - usedTodayBefore),
      remaining,
      overrideSet,
    };

    if (body.run === false) {
      return NextResponse.json({ ok: true, cap: capInfo, ran: false });
    }

    const resolveMetrics = async (platform: Platform, url: string) => {
      // Fail-closed no-Apify: SocialCrawl/YouTube only.
      const { provider, readiness } = await resolveProvider(platform, store, false);
      if (!readiness.ready) return null;
      try {
        return await provider.getVideoMetadata(url);
      } catch {
        return null;
      }
    };
    const catchup = await bootcampMetricsCatchup(store, {
      resolveMetrics,
      activeCap: resolved.activeCap,
      // Re-read the shared credit log (periodically inside the loop) so the catch-up
      // stops at the LIVE cap even if a scheduled refresh spends concurrently. 2000
      // rows comfortably covers a single ET day's attempts across all providers.
      liveUsedToday: async () => socialcrawlCreditsToday(await store.listCollectionAttempts(2000), now, tz).credits,
      maxToProcess: Number.isFinite(Number(body.limit)) && Number(body.limit) > 0 ? Math.floor(Number(body.limit)) : undefined,
      now,
    });
    return NextResponse.json({ ok: true, cap: capInfo, ran: true, catchup });
  } catch (e) {
    return serverError(e, "Bootcamp catch-up failed");
  }
}
