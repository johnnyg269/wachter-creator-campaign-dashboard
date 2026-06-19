// POST /api/admin/repair-thumbnails — run the immediate, safe thumbnail repair
// for active campaign videos missing a cover. Admin-only: accepts an admin
// session OR the server CRON_SECRET bearer (so the admin button and server-side
// automation can both trigger the SAME safe logic). Never public, never Apify.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { bearerMatches, checkAdminRequest } from "@/lib/auth";
import { getAdminPassword, getCronSecret } from "@/lib/config";
import { getStore } from "@/lib/store";
import { repairMissingThumbnails, summarizeRepair } from "@/lib/thumbnail-repair";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  // Fail-closed for this privileged write: if neither admin auth nor a cron
  // secret is configured, never run (don't inherit the dev-open admin gate).
  if (!getAdminPassword() && !getCronSecret()) return false;
  // Admin session (checkAdminRequest returns null when authenticated) OR the
  // server CRON_SECRET as a constant-time Bearer header (never a query param,
  // which would leak the secret into logs/history/Referer).
  if (checkAdminRequest(req) === null) return true;
  return bearerMatches(req.headers.get("authorization"), getCronSecret());
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await repairMissingThumbnails(getStore());
    // Public pages are server-rendered on demand, but revalidate to be safe so
    // recovered covers show immediately on the next view.
    revalidatePath("/videos");
    revalidatePath("/");
    return NextResponse.json({ ok: true, summary: summarizeRepair(result), result });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Thumbnail repair failed" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
