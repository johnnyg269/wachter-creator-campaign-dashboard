// Admin gate. When ADMIN_PASSWORD is set, /admin and the admin APIs require a
// signed, httpOnly session cookie minted by POST /api/admin/login. When it's
// unset (local dev) admin is open and the UI shows a warning banner.
// The password itself never appears in any cookie, page, or log.

import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { getAdminPassword } from "./config";

export const ADMIN_COOKIE = "wachter_admin_session";

function expectedCookieValue(password: string): string {
  return createHmac("sha256", password).update("wachter-admin-session-v1").digest("hex");
}

export function passwordMatches(submitted: string): boolean {
  const password = getAdminPassword();
  if (!password) return true;
  const a = Buffer.from(submitted);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function mintSessionCookie(): string | null {
  const password = getAdminPassword();
  if (!password) return null;
  return expectedCookieValue(password);
}

function isValidSession(value: string | undefined): boolean {
  const password = getAdminPassword();
  if (!password) return true; // no password configured → open (dev only)
  if (!value) return false;
  const expected = expectedCookieValue(password);
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** For server components (admin page). */
export async function isAdminAuthenticated(): Promise<boolean> {
  const jar = await cookies();
  return isValidSession(jar.get(ADMIN_COOKIE)?.value);
}

/** For route handlers. Returns null when authorized, or an error reason. */
export function checkAdminRequest(req: NextRequest): string | null {
  if (isValidSession(req.cookies.get(ADMIN_COOKIE)?.value)) return null;
  return "Admin authentication required";
}

export function adminPasswordConfigured(): boolean {
  return getAdminPassword() !== null;
}
