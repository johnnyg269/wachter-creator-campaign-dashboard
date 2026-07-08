// POST /api/admin/comment-catchup — admin/CRON-bearer manual comment-text catch-up
// for comment-eligible videos (default hot MTL; Bootcamp needs an explicit campaign
// scope). Preview by default (targets + estimated credits, no spend); on confirm it
// raises today's cap by a small limit (auto-expiring, preserves the base cap) and
// pulls comments via SocialCrawl only — NEVER Apify (resolveProvider(..., false)),
// NEVER YouTube (free API lane covers it), NEVER excluded/removed videos.
//
//   body: { confirm?: boolean, platform?, campaign?: "mtl"|"bootcamp",
//           maxVideos?: number, maxCredits?: number }

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { commentCatchupTargets, runCommentCatchup, type CatchupScope } from "@/lib/comment-catchup";
import { resolveProvider } from "@/lib/providers/registry";
import { resolveCreditCap, setCapOverride } from "@/lib/credit-cap";
import { getRefreshPolicyConfig, socialcrawlCreditsToday } from "@/lib/refresh-policy";
import type { Platform, Video } from "@/lib/types";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_MAX_VIDEOS = 25;
const DEFAULT_MAX_CREDITS = 40;

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = (await readJsonObject(req)) ?? {};
    const store = getStore();
    const now = new Date();
    const tz = getRefreshPolicyConfig().quietTimezone;

    const platform = ["tiktok", "instagram", "facebook"].includes(String(body.platform)) ? (body.platform as Platform) : undefined;
    const campaign = body.campaign === "mtl" || body.campaign === "bootcamp" ? body.campaign : undefined;
    const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
    const scope: CatchupScope = {
      platform, campaign,
      maxVideos: num(body.maxVideos, DEFAULT_MAX_VIDEOS),
      maxCredits: num(body.maxCredits, DEFAULT_MAX_CREDITS),
    };

    const targets = commentCatchupTargets(await store.listVideos({ includeHidden: true }), scope, now);
    const estimatedCredits = Math.min(targets.length, scope.maxCredits ?? DEFAULT_MAX_CREDITS);
    const resolved = await resolveCreditCap(store, now);
    const usedToday = socialcrawlCreditsToday(await store.listCollectionAttempts(1500), now, tz).credits;
    const preview = {
      targetCount: targets.length,
      estimatedCredits,
      byPlatform: targets.reduce<Record<string, number>>((a, v) => ((a[v.platform] = (a[v.platform] ?? 0) + 1), a), {}),
      scope: { platform: platform ?? "all(tt/ig/fb)", campaign: campaign ?? "hot-MTL (default)", maxVideos: scope.maxVideos, maxCredits: scope.maxCredits },
      cap: { activeCap: resolved.activeCap, baseCap: resolved.baseCap, usedToday },
    };

    if (body.confirm !== true) {
      return NextResponse.json({ ok: true, ran: false, preview });
    }

    // Raise today's cap by the credit limit so the catch-up has headroom without
    // permanently changing the base cap (auto-expires at the next ET midnight).
    await setCapOverride(store, {
      value: resolved.baseCap + estimatedCredits,
      reason: `comment catch-up (+${estimatedCredits} today only)`,
    });

    const resolveComments = async (p: Platform, v: Video) => {
      const { provider, readiness } = await resolveProvider(p, store, false); // fail-closed: no Apify
      if (!readiness.ready || !provider.supportsComments) return null;
      try {
        return await provider.getVideoComments(v);
      } catch {
        return null;
      }
    };

    const result = await runCommentCatchup(store, { resolveComments, scope, now });
    return NextResponse.json({ ok: true, ran: true, preview, result });
  } catch (e) {
    return serverError(e, "Comment catch-up failed");
  }
}
