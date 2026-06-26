// April Facebook reels (MTL-tagged, below the June MTL floor → invisible in both
// views) review + one-click reassign to Bootcamp. Admin session OR CRON_SECRET
// bearer (fail-closed). The candidate set is derived from strict criteria
// server-side, so this can only ever touch those specific records.
//
//   GET                          → list candidates (read-only, full detail)
//   POST {}                      → same list (preview, no write)
//   POST { confirm: true, ids? } → reassign candidates (optionally restricted to
//                                  the reviewed `ids`) MTL→Bootcamp. Pure tag
//                                  patch — keeps metrics + tracking, no Apify,
//                                  no SocialCrawl, reversible via bulk-assign.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { listAprilFbCandidates, reassignAprilFbToBootcamp } from "@/lib/april-fb-reassign";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, candidates: await listAprilFbCandidates(getStore(), new Date()) });
  } catch (e) {
    return serverError(e, "Listing April FB candidates failed");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await readJsonObject(req)) ?? {};
    const store = getStore();
    const now = new Date();
    const candidates = await listAprilFbCandidates(store, now);
    if (body.confirm !== true) {
      return NextResponse.json({ ok: true, ran: false, candidates });
    }
    const onlyIds = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : undefined;
    const result = await reassignAprilFbToBootcamp(store, { onlyIds, now });
    return NextResponse.json({ ok: true, ran: true, result });
  } catch (e) {
    return serverError(e, "Reassigning April FB reels failed");
  }
}
