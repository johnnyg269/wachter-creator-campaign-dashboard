// POST /api/admin/logout → clears the admin session cookie.

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE } from "@/lib/auth";
import { guardAdmin } from "../_utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = guardAdmin(req);
  if (denied) return denied;

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
