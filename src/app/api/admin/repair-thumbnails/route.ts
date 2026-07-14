// POST /api/admin/repair-thumbnails — run the immediate, safe thumbnail repair
// for active campaign videos missing a cover. Admin-only: accepts an admin
// session OR the server CRON_SECRET bearer (so the admin button and server-side
// automation can both trigger the SAME safe logic). Never public, never Apify.

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { getStore } from "@/lib/store";
import { repairMissingThumbnails, summarizeRepair } from "@/lib/thumbnail-repair";
import { isAdminOrCronBearer, readJsonObject } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  // Real admin session (password-configured) OR CRON_SECRET bearer — shared,
  // fail-closed; the dev-open session path never grants access to this write.
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Optional body: { verifyFacebook?: boolean, maxTotal?: number }. Defaults
    // run the FULL safe fix — force a detail retry even on covers the profile
    // loop marked "failed", AND server-probe stored fbcdn covers so silently
    // EXPIRED ones (present URL, frozen "valid") get re-resolved too.
    const body = (await readJsonObject(req)) ?? {};
    const verifyFacebook = body.verifyFacebook !== false;
    const maxTotal = typeof body.maxTotal === "number" && body.maxTotal > 0 ? Math.floor(body.maxTotal) : undefined;
    const result = await repairMissingThumbnails(getStore(), { force: true, verifyFacebook, maxTotal });
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
