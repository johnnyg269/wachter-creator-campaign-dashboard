// GET /api/thumb?src=<https CDN url> — server-side thumbnail proxy.
// Social CDNs (Instagram/Facebook) reject browser hotlinking; a plain server
// fetch succeeds. Host-allowlisted so this is not an open proxy. No auth headers
// or secrets are ever attached to the outbound request.
//
// NOTE: TikTok's signed image CDN (p16-*.tiktokcdn-us.com) blocks server-side
// fetches from datacenter/serverless IPs (the fetch is reset → "Fetch failed"),
// and its covers are HEIC (browser-unrenderable) on expiring signed URLs. So
// TikTok thumbnails cannot be served through this proxy from Vercel; the UI
// degrades to a polished branded placeholder. The SocialCrawl provider drops
// HEIC covers (see pickThumbnail) so unrenderable URLs aren't stored.

import { type NextRequest, NextResponse } from "next/server";
import { isAllowedThumbHost } from "@/lib/thumb-proxy";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  const src = req.nextUrl.searchParams.get("src");
  if (!src || !isAllowedThumbHost(src)) {
    return NextResponse.json({ ok: false, error: "Invalid or disallowed src" }, { status: 400 });
  }
  try {
    const upstream = await fetch(src, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
      // Plain anonymous fetch — no cookies, no referrer, no credentials.
      headers: { Accept: "image/*" },
    });
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.startsWith("image/")) {
      return NextResponse.json({ ok: false, error: `Upstream ${upstream.status}` }, { status: 404 });
    }
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "Image too large" }, { status: 404 });
    }
    return new Response(buf, {
      headers: {
        "Content-Type": type,
        // CDN URLs are signed/rotating; cache the bytes for an hour at the
        // edge and let stale copies serve while revalidating.
        "Cache-Control": "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Fetch failed" }, { status: 404 });
  }
}
