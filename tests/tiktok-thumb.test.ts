// TikTok thumbnail fix: the /api/thumb proxy transcodes HEIC → JPEG so TikTok's
// signed HEIC covers (unrenderable in any browser <img>) become renderable, and
// thumbSrc routes TikTok through the proxy. Plus last-known-good preservation /
// no-overwrite / valid_unverified render / retry recovery for TikTok, and that
// the render fix touches no metrics/totals/campaign data.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { thumbSrc, isTikTokCdnHost, isAllowedThumbHost } from "@/lib/thumb-proxy";
import { nextThumbnailState, initialThumbState, type ThumbnailState } from "@/lib/thumbnail-state";

const TT = "https://p16-common-sign.tiktokcdn-us.com/x~tplv-tiktokx-cropcenter-q:300:400:q70.heic?x-expires=1&x-signature=z";
const IG = "https://scontent.cdninstagram.com/x.jpg";
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22]);

// ── thumbSrc routing ─────────────────────────────────────────────────────────
describe("thumbSrc — TikTok routed through the transcoding proxy", () => {
  it("sends TikTok HEIC covers through /api/thumb (NOT direct)", () => {
    expect(thumbSrc(TT)).toBe(`/api/thumb?src=${encodeURIComponent(TT)}`);
    expect(thumbSrc(TT)).not.toBe(TT);
  });
  it("still proxies Instagram/Facebook and null-guards", () => {
    expect(thumbSrc(IG)).toMatch(/^\/api\/thumb\?src=/);
    expect(thumbSrc(null)).toBeNull();
  });
  it("TikTok hosts are allow-listed + recognised as TikTok CDN", () => {
    expect(isAllowedThumbHost(TT)).toBe(true);
    expect(isTikTokCdnHost(TT)).toBe(true);
  });
});

// ── /api/thumb HEIC → JPEG transcode (heic-convert mocked) ──────────────────
const convertMock = vi.hoisted(() => vi.fn(async () => JPEG_MAGIC.buffer.slice(0)));
vi.mock("heic-convert", () => ({ default: convertMock }));

describe("/api/thumb — HEIC transcode + passthrough", () => {
  let GET: (req: NextRequest) => Promise<Response>;
  beforeEach(async () => {
    convertMock.mockClear();
    ({ GET } = await import("@/app/api/thumb/route"));
  });
  afterEach(() => vi.unstubAllGlobals());

  const stubUpstream = (contentType: string, body: Uint8Array = new Uint8Array([1, 2, 3, 4]), status = 200) =>
    // .slice().buffer yields a plain ArrayBuffer (valid BodyInit) — sidesteps the
    // TS lib quirk where Uint8Array<ArrayBufferLike> isn't assignable to BodyInit.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(status === 200 ? body.slice().buffer : null, { status, headers: { "content-type": contentType } })));

  const call = (src: string) => GET(new NextRequest(`https://app/api/thumb?src=${encodeURIComponent(src)}`));

  it("transcodes an image/heic upstream to image/jpeg", async () => {
    stubUpstream("image/heic");
    const res = await call(TT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("X-Thumb-Transcoded")).toBe("heic-jpeg");
    expect(convertMock).toHaveBeenCalledTimes(1);
  });

  it("transcodes when the URL ends .heic even if the CDN mislabels the type", async () => {
    stubUpstream("image/jpeg"); // wrong label, but the .heic URL triggers transcode
    const res = await call(TT);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(convertMock).toHaveBeenCalledTimes(1);
  });

  it("passes a real JPEG through untouched (no transcode)", async () => {
    stubUpstream("image/jpeg");
    const res = await call(IG);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("X-Thumb-Transcoded")).toBeNull();
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("falls back to the original bytes if the HEIC decode throws (never a hard error)", async () => {
    convertMock.mockRejectedValueOnce(new Error("bad heic"));
    stubUpstream("image/heic");
    const res = await call(TT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/heic"); // original, unconverted
    expect(convertMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a disallowed host (not an open proxy)", async () => {
    stubUpstream("image/jpeg");
    const res = await call("https://evil.example.com/x.heic");
    expect(res.status).toBe(400);
    expect(convertMock).not.toHaveBeenCalled();
  });

  it("404s a non-image upstream", async () => {
    stubUpstream("text/html");
    const res = await call(IG);
    expect(res.status).toBe(404);
  });
});

// ── TikTok thumb-state: last-known-good, no-overwrite, retry ────────────────
const now = "2026-07-14T12:00:00Z";
const VU = (): ThumbnailState => ({ status: "valid_unverified", attempts: 0, lastAttemptAt: now, nextRetryAt: null, failureReason: null, resolvedFrom: "provider" });

describe("TikTok thumb state", () => {
  it("stores a TikTok cover as valid_unverified and keeps its URL", () => {
    const r = initialThumbState({ thumbnailUrl: TT, now, verifiable: false });
    expect(r.thumbnailUrl).toBe(TT);
    expect(r.thumb.status).toBe("valid_unverified");
  });
  it("never overwrites a good TikTok cover when the provider returns none", () => {
    const r = nextThumbnailState({ resolvedUrl: null, existingUrl: TT, prev: VU(), isDiscovery: true, now, verifiable: false });
    expect(r.thumbnailUrl).toBe(TT); // last-known-good preserved
    expect(r.thumb.status).toBe("valid_unverified");
  });
  it("recovers a missing TikTok cover on a later discovery pull (retry works)", () => {
    const missing: ThumbnailState = { status: "retry_pending", attempts: 1, lastAttemptAt: now, nextRetryAt: "next discovery pull", failureReason: "x", resolvedFrom: null };
    const r = nextThumbnailState({ resolvedUrl: TT, existingUrl: null, prev: missing, isDiscovery: true, now, verifiable: false });
    expect(r.thumbnailUrl).toBe(TT);
    expect(r.thumb.status).toBe("valid_unverified");
  });
});

// ── Source-level: admin grid + drawer read the same thumbnail field ─────────
import { readFileSync } from "fs";
import path from "path";
describe("grid + drawer consistency (source-level)", () => {
  const explorer = readFileSync(path.join(process.cwd(), "src/app/videos/videos-explorer.tsx"), "utf-8");
  it("both the card and the drawer render VideoThumb from v.thumbnailUrl", () => {
    const uses = [...explorer.matchAll(/<VideoThumb\s+src=\{([^}]+)\}/g)].map((m) => m[1].trim());
    expect(uses.length).toBeGreaterThanOrEqual(2); // card + drawer (+ leaders/removed)
    // every VideoThumb is fed a thumbnailUrl (v.thumbnailUrl / r.thumbnailUrl), never a raw field
    expect(uses.every((u) => /thumbnailUrl/.test(u))).toBe(true);
  });
});
