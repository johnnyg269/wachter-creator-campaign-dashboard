// Scheduled refresh endpoint. Protected by CRON_SECRET.
// Vercel Cron sends "Authorization: Bearer $CRON_SECRET" automatically when
// the env var is set; external schedulers can use the same header or
// ?secret=... as a fallback.
//
// Responds 202 immediately and runs the refresh after the response (via
// after()), because the primary scheduler — cron-job.org free tier — caps
// requests at 30s while a full refresh takes minutes; a blocking response
// made every execution register there as a timeout failure, which risks the
// job being auto-disabled. Pass ?sync=1 to block and get the full report
// back (debugging / manual curl). The refresh lock in runRefresh still
// prevents overlapping runs in both modes.

import { after, type NextRequest, NextResponse } from "next/server";
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
  if (req.nextUrl.searchParams.get("sync") === "1") {
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
  after(async () => {
    try {
      await runRefresh("cron");
    } catch (e) {
      console.error("[cron/refresh] background refresh failed:", e);
    }
  });
  return NextResponse.json({ ok: true, accepted: true }, { status: 202 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
