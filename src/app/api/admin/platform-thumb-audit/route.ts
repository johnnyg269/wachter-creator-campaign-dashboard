// GET /api/admin/platform-thumb-audit — read-only per-platform thumbnail audit
// (TikTok / Instagram / Facebook / YouTube): stored state by status/host/format,
// proxy live-probe for the proxiable CDNs, and TikTok URL-format + raw-cover
// evidence. Admin session OR CRON_SECRET bearer (fail-closed). No writes, no
// provider credits, no Apify.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { auditPlatformThumbnails } from "@/lib/platform-thumb-audit";
import { isAdminOrCronBearer, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, audit: await auditPlatformThumbnails(getStore(), new Date()) });
  } catch (e) {
    return serverError(e, "Platform thumbnail audit failed");
  }
}
