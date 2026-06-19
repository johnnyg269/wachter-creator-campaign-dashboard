// Scheduled refresh endpoint. Protected by CRON_SECRET via the
// "Authorization: Bearer $CRON_SECRET" header ONLY (constant-time check). A
// query-param secret is intentionally not accepted — it would leak into access
// logs and browser history. cron-job.org and the GitHub Actions backup both
// send the header.
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
import { bearerMatches } from "@/lib/auth";
import { runRefresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  // Header-only, constant-time. Both schedulers (cron-job.org + the GitHub
  // Actions backup) send "Authorization: Bearer $CRON_SECRET"; a ?secret= query
  // param would leak the secret into access logs / history, so it isn't accepted.
  return bearerMatches(req.headers.get("authorization"), getCronSecret());
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
