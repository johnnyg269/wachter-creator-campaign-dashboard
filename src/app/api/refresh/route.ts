// Manual refresh endpoint — ADMIN ONLY. Public viewers read the shared
// Supabase data; only the authenticated admin session (or the secret-protected
// cron endpoint) can spend Apify credits. The refresh gate in lib/refresh.ts
// additionally blocks overlaps and too-frequent manual runs.

import { type NextRequest, NextResponse } from "next/server";
import { runRefresh } from "@/lib/refresh";
import { checkAdminRequest } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = checkAdminRequest(req);
  if (denied) {
    return NextResponse.json(
      { ok: false, error: "Refreshes run automatically on a scheduled cadence. Admin sign-in is required for manual refresh." },
      { status: 401 },
    );
  }
  let force = false;
  try {
    const body = (await req.json()) as { force?: boolean } | null;
    force = body?.force === true;
  } catch {
    // no body — plain manual refresh
  }
  try {
    const report = await runRefresh("manual", { force });
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Refresh failed" },
      { status: 500 },
    );
  }
}
