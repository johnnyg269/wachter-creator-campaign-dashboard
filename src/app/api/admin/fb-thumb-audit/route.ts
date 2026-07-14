// GET /api/admin/fb-thumb-audit — read-only Facebook thumbnail audit: stored
// state by status/host, plus a live proxy-fetch test of a sample of stored fbcdn
// URLs to distinguish expired/blocked from live. Admin session OR CRON_SECRET
// bearer (fail-closed). No writes, no provider credits, no Apify.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { auditFacebookThumbnails } from "@/lib/fb-thumb-audit";
import { isAdminOrCronBearer, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, audit: await auditFacebookThumbnails(getStore(), new Date()) });
  } catch (e) {
    return serverError(e, "FB thumbnail audit failed");
  }
}
