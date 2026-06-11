// Manual refresh endpoint (UI button). Long-running: Apify actor runs can
// take a couple of minutes per platform.

import { NextResponse } from "next/server";
import { runRefresh } from "@/lib/refresh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(): Promise<NextResponse> {
  try {
    const report = await runRefresh("manual");
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Refresh failed" },
      { status: 500 },
    );
  }
}
