// YouTube Shorts discovery health + catch-up. Admin session OR CRON_SECRET
// bearer (fail-closed). FREE YouTube Data API only — zero SocialCrawl credits,
// never Apify, never re-adds excluded/removed videos, real metrics only.
//
//   GET                            → discovery health (probe + staleness, read-only)
//   POST {}                        → 30-day dry-run scan (found/tracked/missing, no writes)
//   POST { confirm: true, days?, checkUrl? } → insert missing Shorts (+ initial
//                                    metrics/comments) through the safe path.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { youtubeDiscoveryHealth, youtubeShortsCatchup } from "@/lib/youtube-catchup";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, health: await youtubeDiscoveryHealth(getStore(), new Date()) });
  } catch (e) {
    return serverError(e, "YouTube discovery health failed");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await readJsonObject(req)) ?? {};
    const store = getStore();
    const result = await youtubeShortsCatchup(store, {
      sinceDays: Number.isFinite(Number(body.days)) && Number(body.days) > 0 ? Number(body.days) : 30,
      insert: body.confirm === true,
      checkUrl: typeof body.checkUrl === "string" ? body.checkUrl : undefined,
      now: new Date(),
    });
    return NextResponse.json({ ok: true, ran: body.confirm === true, result });
  } catch (e) {
    return serverError(e, "YouTube catch-up failed");
  }
}
