// Lightweight health endpoint used by the header's data-health indicator.

import { NextResponse } from "next/server";
import { getHealth } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const health = await getHealth();
    return NextResponse.json({ ok: true, health });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Status check failed" },
      { status: 500 },
    );
  }
}
