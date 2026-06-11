// Mark an alert as reviewed. Called by the "Mark reviewed" button on /alerts.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  try {
    const alert = await getStore().reviewAlert(id);
    return NextResponse.json({ ok: true, alert });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : `Alert ${id} not found` },
      { status: 404 },
    );
  }
}
