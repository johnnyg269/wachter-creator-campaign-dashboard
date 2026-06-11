// Scheduled refresh endpoint. Protected by CRON_SECRET.
// Vercel Cron sends "Authorization: Bearer $CRON_SECRET" automatically when
// the env var is set; external schedulers can use the same header or
// ?secret=... as a fallback.

import { type NextRequest, NextResponse } from "next/server";
import { getCronSecret } from "@/lib/config";
import { runRefresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const secret = getCronSecret();
  if (!secret) return false; // never run an unprotected public cron endpoint
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  return req.nextUrl.searchParams.get("secret") === secret;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json(
      { ok: false, error: getCronSecret() ? "Unauthorized" : "CRON_SECRET is not configured" },
      { status: 401 },
    );
  }
  try {
    const report = await runRefresh("cron");
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Refresh failed" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
