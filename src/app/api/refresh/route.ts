// Manual refresh endpoint — ADMIN ONLY. Public viewers read the shared
// Supabase data; only the authenticated admin session (or the secret-protected
// cron endpoint) can spend Apify credits. The refresh gate in lib/refresh.ts
// additionally blocks overlaps and too-frequent manual runs.

import { type NextRequest, NextResponse } from "next/server";
import { runRefresh, type RefreshModeName } from "@/lib/refresh";
import { bearerMatches, checkAdminRequest } from "@/lib/auth";
import { getCronSecret } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODES: RefreshModeName[] = ["metrics", "discovery", "full"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Admin session OR the server CRON_SECRET as a constant-time Bearer header
  // (header-only — lets server-side automation trigger a manual run, e.g. an
  // immediate comment pull, without exposing the secret in a URL). Never public.
  const authed =
    checkAdminRequest(req) === null || bearerMatches(req.headers.get("authorization"), getCronSecret());
  if (!authed) {
    return NextResponse.json(
      { ok: false, error: "Refreshes run automatically on a scheduled cadence. Admin sign-in is required for manual refresh." },
      { status: 401 },
    );
  }
  let force = false;
  let mode: RefreshModeName | undefined;
  try {
    const body = (await req.json()) as { force?: boolean; mode?: string } | null;
    force = body?.force === true;
    if (body?.mode && MODES.includes(body.mode as RefreshModeName)) {
      mode = body.mode as RefreshModeName;
    }
  } catch {
    // no body — plain manual refresh (defaults to full: metrics + discovery)
  }
  try {
    const report = await runRefresh("manual", { force, mode });
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Refresh failed" },
      { status: 500 },
    );
  }
}
