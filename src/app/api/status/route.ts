// Lightweight, PUBLIC health endpoint (no auth) used by the header's
// data-health indicator. It returns only freshness/availability — never the
// data-source vendor or collector ids, which are internal/admin-only.

import { NextResponse } from "next/server";
import { getHealth, toPublicHealth } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const health = await getHealth();
    // Public projection: strip vendor/provider internals (the data-source
    // type, collector ids, status detail) and raw run logs. Keep only what a
    // status badge needs. See toPublicHealth (pure + unit-tested).
    return NextResponse.json({ ok: true, health: toPublicHealth(health) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Status check failed" },
      { status: 500 },
    );
  }
}
