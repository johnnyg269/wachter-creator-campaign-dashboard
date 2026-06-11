// GET /api/admin/actor-search?q=tiktok+scraper — Apify Store search helper.

import { NextResponse, type NextRequest } from "next/server";
import { searchApifyStore } from "@/lib/apify/client";
import { badRequest, guardAdmin, serverError } from "../_utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return badRequest("Query parameter q is required");

  try {
    const results = await searchApifyStore(q);
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return serverError(e, "Apify Store search failed");
  }
}
