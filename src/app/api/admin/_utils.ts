// Shared helpers for the admin API routes: auth guard, body parsing, and
// consistent { ok, error } JSON envelopes. Never log or echo secrets here.

import { NextResponse, type NextRequest } from "next/server";
import { bearerMatches, checkAdminRequest } from "@/lib/auth";
import { getAdminPassword, getCronSecret } from "@/lib/config";
import { PLATFORMS, type Platform } from "@/lib/types";

/** Returns a 401 response when the request is not an authenticated admin. */
export function guardAdmin(req: NextRequest): NextResponse | null {
  const reason = checkAdminRequest(req);
  if (reason) {
    return NextResponse.json({ ok: false, error: reason }, { status: 401 });
  }
  return null;
}

/**
 * Privileged admin ACTION gate (cost-bearing / write routes): a REAL
 * authenticated admin session — which REQUIRES a configured ADMIN_PASSWORD, so
 * the dev-open "no password → open" session semantics never grant access here —
 * OR the server CRON_SECRET as a constant-time Bearer header. Fail-closed when
 * NEITHER secret is configured. This prevents the trap where a deployment sets
 * CRON_SECRET (for the scheduler) but not ADMIN_PASSWORD: such a route must stay
 * bearer-only, never world-open via the dev-open session path.
 */
export function isAdminOrCronBearer(req: NextRequest): boolean {
  if (!getAdminPassword() && !getCronSecret()) return false;
  if (getAdminPassword() && checkAdminRequest(req) === null) return true;
  return bearerMatches(req.headers.get("authorization"), getCronSecret());
}

/** Parses a JSON object body; null when missing/invalid/not an object. */
export async function readJsonObject(
  req: NextRequest,
): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function badRequest(error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

export function notFound(error: string): NextResponse {
  return NextResponse.json({ ok: false, error }, { status: 404 });
}

export function serverError(e: unknown, fallback: string): NextResponse {
  const message = e instanceof Error ? e.message : fallback;
  return NextResponse.json({ ok: false, error: message }, { status: 500 });
}

export function isPlatform(v: unknown): v is Platform {
  return typeof v === "string" && (PLATFORMS as string[]).includes(v);
}

/** Trimmed non-empty string, else null. */
export function asTrimmedString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Optional non-negative metric value: undefined/null/"" → null (not provided);
 * otherwise must coerce to a finite non-negative number.
 */
export function asMetric(v: unknown): { ok: true; value: number | null } | { ok: false } {
  if (v === undefined || v === null || v === "") return { ok: true, value: null };
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: Math.round(n) };
}

/** Parses a date-ish string into ISO; null on failure. */
export function asIsoDate(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}
