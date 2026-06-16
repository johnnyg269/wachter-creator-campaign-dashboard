// GET /api/thumb?src=<https CDN url> — server-side thumbnail proxy.
// Social CDNs (Instagram/Facebook/TikTok) reject browser hotlinking; a plain
// server fetch succeeds. Host-allowlisted so this is not an open proxy.
// No auth headers or secrets are ever attached to the outbound request.

import { type NextRequest, NextResponse } from "next/server";
import { isAllowedThumbHost } from "@/lib/thumb-proxy";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

// Formats browsers render natively — passed through untouched. Anything else
// (notably image/heic, which TikTok serves for thumbnails) is transcoded to JPEG
// via sharp so the <img> can display it instead of falling back to a placeholder.
const BROWSER_SAFE = /^image\/(jpeg|png|webp|gif|avif|svg\+xml)\b/i;

async function toBrowserSafe(
  buf: Buffer,
  contentType: string,
): Promise<{ buf: Buffer; type: string } | { error: string }> {
  if (BROWSER_SAFE.test(contentType)) return { buf, type: contentType };
  // Non-web-safe (e.g. HEIC/HEIF/TIFF): transcode to JPEG. sharp is a declared
  // dependency; if it's unavailable or the decode fails, signal a miss so the
  // caller returns 404 and the UI keeps its last-known-good thumbnail. The short
  // error string surfaces (decode-vs-load) in a non-secret diagnostic header.
  try {
    const sharp = (await import("sharp")).default;
    const out = await sharp(buf).rotate().jpeg({ quality: 82 }).toBuffer();
    return { buf: out, type: "image/jpeg" };
  } catch (e) {
    return { error: e instanceof Error ? e.message.slice(0, 80) : "transcode failed" };
  }
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
    const raw = Buffer.from(await upstream.arrayBuffer());
    if (raw.byteLength > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: "Image too large" }, { status: 404 });
    }
    const safe = await toBrowserSafe(raw, type);
    if ("error" in safe) {
      return NextResponse.json(
        { ok: false, error: "Unrenderable image" },
        { status: 404, headers: { "x-thumb-transcode": safe.error } },
      );
    }
    return new Response(new Uint8Array(safe.buf), {
      headers: {
        "Content-Type": safe.type,
        // CDN URLs are signed/rotating; cache the bytes for an hour at the
        // edge and let stale copies serve while revalidating.
        "Cache-Control": "public, max-age=900, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Fetch failed" }, { status: 404 });
  }
}
