// Manual refresh endpoint (UI button). Long-running: Apify actor runs can
// take a couple of minutes per platform.

import { NextResponse } from "next/server";
import { runRefresh } from "@/lib/refresh";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Public manual refresh is throttled — each refresh costs real actor runs. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

export async function POST(): Promise<NextResponse> {
  try {
    const [latest] = await getStore().listRefreshRuns(1);
    if (latest && Date.now() - new Date(latest.startedAt).getTime() < MIN_INTERVAL_MS) {
      const ageMin = Math.max(1, Math.round((Date.now() - new Date(latest.startedAt).getTime()) / 60000));
      return NextResponse.json(
        {
          ok: false,
          error: `Data was refreshed ${ageMin} minute${ageMin === 1 ? "" : "s"} ago — try again shortly.`,
        },
        { status: 429 },
      );
    }
    const report = await runRefresh("manual");
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Refresh failed" },
      { status: 500 },
    );
  }
}
