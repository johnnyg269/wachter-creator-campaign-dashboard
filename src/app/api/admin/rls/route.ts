// GET  /api/admin/rls        — read-only RLS + grants audit of every public table
// POST /api/admin/rls {confirm:true[,revokeGrants:false]} — enable RLS (deny-by-
//   default, not forced) on every public table + revoke anon/authenticated grants.
//
// Admin session OR CRON_SECRET bearer (fail-closed). Runs through the app's own
// Prisma connection (the table-owning role, which bypasses RLS), so it never
// locks the app out — applyRls additionally refuses unless that is provably true.
// Postgres-backend only; no-op with a clear message on the JSON-file store.

import { NextResponse, type NextRequest } from "next/server";
import { isAdminOrCronBearer, readJsonObject, serverError } from "../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function noDb(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "No Postgres backend (DATABASE_URL unset) — RLS applies only to the Supabase/Postgres store." },
    { status: 400 },
  );
}

async function prisma() {
  const { getPrismaClient } = await import("@/lib/store/prisma-store");
  return getPrismaClient();
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!process.env.DATABASE_URL?.trim()) return noDb();
  try {
    const { auditRls } = await import("@/lib/rls-maintenance");
    return NextResponse.json({ ok: true, audit: await auditRls(await prisma()) });
  } catch (e) {
    return serverError(e, "RLS audit failed");
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAdminOrCronBearer(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!process.env.DATABASE_URL?.trim()) return noDb();
  const body = (await readJsonObject(req)) ?? {};
  if (body.confirm !== true) {
    return NextResponse.json({ ok: false, error: 'Pass {"confirm":true} to apply RLS. GET this endpoint first to preview.' }, { status: 400 });
  }
  try {
    const { applyRls } = await import("@/lib/rls-maintenance");
    const result = await applyRls(await prisma(), { revokeGrants: body.revokeGrants !== false });
    return NextResponse.json({ ok: result.applied, result });
  } catch (e) {
    return serverError(e, "RLS fix failed");
  }
}
