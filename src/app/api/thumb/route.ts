// GET /api/thumb?src=<https CDN url> — server-side thumbnail proxy.
// Social CDNs (Instagram/Facebook/TikTok) reject browser hotlinking or serve a
// browser-unrenderable format; a plain server fetch succeeds. Host-allowlisted
// so this is not an open proxy. No auth headers or secrets are ever attached to
// the outbound request.
//
// TikTok: its covers are HEIC on signed p16-*.tiktokcdn-us.com URLs. The server
// CAN fetch them (verified), but no browser can decode HEIC in an <img>, so we
// TRANSCODE HEIC/HEIF → JPEG here (heic-convert, pure-WASM libheif) and serve the
// JPEG. The stored URL is never modified — last-known-good is preserved; only the
// bytes we return are converted. Result is edge-cached for an hour.

import { type NextRequest, NextResponse } from "next/server";
import { isAllowedThumbHost } from "@/lib/thumb-proxy";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const MAX_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const CACHE = "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400";

function looksHeic(contentType: string, src: string): boolean {
  return /hei[cf]/i.test(contentType) || /\.hei[cf](\?|$)/i.test(src);
}

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

    // HEIC/HEIF is unrenderable in browsers → transcode to JPEG. On any decode
    // failure, fall through to serving the original bytes (no worse than before).
    if (looksHeic(type, src)) {
      try {
        const convert = (await import("heic-convert")).default;
        const jpeg = await convert({ buffer: Buffer.from(buf), format: "JPEG", quality: 0.82 });
        return new Response(Buffer.from(jpeg), {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": CACHE, "X-Thumb-Transcoded": "heic-jpeg" },
        });
      } catch {
        // decode failed — serve original (browser will fall back to placeholder)
      }
    }

    return new Response(buf, {
      headers: {
        "Content-Type": type,
        // CDN URLs are signed/rotating; cache the bytes for an hour at the
        // edge and let stale copies serve while revalidating.
        "Cache-Control": CACHE,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Fetch failed" }, { status: 404 });
  }
}
