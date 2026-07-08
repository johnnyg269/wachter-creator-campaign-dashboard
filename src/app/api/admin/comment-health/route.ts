// GET /api/admin/comment-health — read-only comment-collection health: stored
// counts + recency (by platform/campaign/window), latest pull, comment-eligible
// vs skipped videos by reason + tier, and the governing config. Explains why
// comment text is or isn't being pulled (hot-MTL-only gating). Admin session OR
// CRON_SECRET bearer (fail-closed). No writes, no provider calls, no Apify.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { computeCommentHealth } from "@/lib/comment-health";
import { isAdminOrCronBearer, serverError } from "../_utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, health: await computeCommentHealth(getStore(), new Date()) });
  } catch (e) {
    return serverError(e, "Comment health failed");
  }
}
