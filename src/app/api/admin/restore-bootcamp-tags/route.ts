// Restore stranded Bootcamp videos (currently MTL-tagged + published before the
// MTL floor → invisible in both views, e.g. tags lost to a refresh rawJson
// overwrite). Admin session OR CRON_SECRET bearer (fail-closed). Candidates are
// derived from strict criteria server-side, so this can only touch those records.
//
//   GET / POST {}                → list candidates (read-only, full detail)
//   POST { confirm: true, ids? } → reassign candidates (optionally restricted to
//                                  the reviewed `ids`) MTL→Bootcamp. Pure tag
//                                  patch — keeps metrics + tracking, no Apify,
//                                  no SocialCrawl, reversible via bulk-assign.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { listStrandedBootcampCandidates, restoreStrandedBootcampTags } from "@/lib/restore-bootcamp-tags";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, candidates: await listStrandedBootcampCandidates(getStore(), new Date()) });
  } catch (e) {
    return serverError(e, "Listing stranded Bootcamp candidates failed");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await readJsonObject(req)) ?? {};
    const store = getStore();
    const now = new Date();
    const candidates = await listStrandedBootcampCandidates(store, now);
    if (body.confirm !== true) {
      return NextResponse.json({ ok: true, ran: false, candidates });
    }
    const onlyIds = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : undefined;
    const result = await restoreStrandedBootcampTags(store, { onlyIds, now });
    return NextResponse.json({ ok: true, ran: true, result });
  } catch (e) {
    return serverError(e, "Restoring stranded Bootcamp tags failed");
  }
}
