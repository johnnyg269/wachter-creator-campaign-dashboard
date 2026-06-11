// POST /api/admin/login { password } → sets the httpOnly admin session
// cookie on success. The password is never logged, stored, or echoed back.

import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE, mintSessionCookie, passwordMatches } from "@/lib/auth";
import { readJsonObject } from "../_utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await readJsonObject(req);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!passwordMatches(password)) {
    return NextResponse.json({ ok: false, error: "Incorrect password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  const session = mintSessionCookie();
  // When no ADMIN_PASSWORD is configured admin is open — no cookie needed.
  if (session) {
    res.cookies.set(ADMIN_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  return res;
}
