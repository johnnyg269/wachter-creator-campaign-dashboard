// Facebook Reels thumbnail reliability: prioritized extraction across actor
// surfaces, video-URL rejection, proxy allowlist hardening, and fallback.

import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { isUsableThumbUrl, resolveThumb } from "@/lib/apify/normalize";
import { isAllowedThumbHost, thumbSrc } from "@/lib/thumb-proxy";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const IMG = "https://scontent-dfw5-2.xx.fbcdn.net/v/t15.5256-10/719598266_209.jpg";

describe("resolveThumb — prioritized Facebook extraction", () => {
  it("uses direct top-level fields first", () => {
    const r = resolveThumb({ thumbnail: IMG, media: [{ image: { uri: "https://scontent-x.xx.fbcdn.net/other.jpg" } }] });
    expect(r?.path).toBe("thumbnail");
    expect(r?.url).toBe(IMG);
  });
  it("extracts from nested reel-page media entries (the surface that was NULL)", () => {
    expect(resolveThumb({ media: [{ thumbnail: IMG }] })?.path).toBe("media.0.thumbnail");
    expect(resolveThumb({ media: [{ thumbnailImage: { uri: IMG } }] })?.path).toBe(
      "media.0.thumbnailImage.uri",
    );
    expect(resolveThumb({ media: [{ preferred_thumbnail: { image: { uri: IMG } } }] })?.path).toBe(
      "media.0.preferred_thumbnail.image.uri",
    );
    expect(resolveThumb({ media: [{ image: { uri: IMG } }] })?.path).toBe("media.0.image.uri");
  });
  it("extracts preferred_thumbnail and attachment variants", () => {
    expect(resolveThumb({ preferred_thumbnail: { image: { uri: IMG } } })?.url).toBe(IMG);
    expect(resolveThumb({ attachments: [{ media: { image: { uri: IMG } } }] })?.url).toBe(IMG);
    expect(resolveThumb({ full_picture: IMG })?.url).toBe(IMG);
  });
  it("NEVER uses playable/video URLs as images", () => {
    expect(isUsableThumbUrl("https://video-dfw5-1.xx.fbcdn.net/o1/v/clip")).toBe(false);
    expect(isUsableThumbUrl("https://scontent.xx.fbcdn.net/reel.mp4")).toBe(false);
    expect(isUsableThumbUrl("https://scontent.xx.fbcdn.net/manifest.mpd?x=1")).toBe(false);
    expect(isUsableThumbUrl(IMG)).toBe(true);
    expect(
      resolveThumb({ thumbnail: "https://video-dfw5-1.xx.fbcdn.net/o1/v/x", media: [{ image: { uri: IMG } }] })?.url,
    ).toBe(IMG); // skips the video URL, falls through to the real image
  });
  it("returns null (→ platform fallback, never a broken image) when nothing usable exists", () => {
    expect(resolveThumb({ media: [{ videoDeliveryLegacyFields: { browser_native_sd_url: "https://video-x.xx.fbcdn.net/v" } }] })).toBeNull();
  });
});

describe("thumbnail proxy hardening", () => {
  it("allows real Facebook CDN hosts (scontent-*.fbcdn.net)", () => {
    expect(isAllowedThumbHost(IMG)).toBe(true);
    expect(isAllowedThumbHost("https://scontent-den2-1.xx.fbcdn.net/v/x.jpg")).toBe(true);
  });
  it("rejects spoofed lookalike domains and downgraded schemes", () => {
    expect(isAllowedThumbHost("https://evilfbcdn.net/x.jpg")).toBe(false);
    expect(isAllowedThumbHost("https://fbcdn.net.evil.com/x.jpg")).toBe(false);
    expect(isAllowedThumbHost("https://scontent.fbcdn.net.attacker.io/x.jpg")).toBe(false);
    expect(isAllowedThumbHost("http://scontent-dfw5-2.xx.fbcdn.net/x.jpg")).toBe(false);
  });
  it("routes Facebook CDN images through /api/thumb (no raw signed URLs in <img src>)", () => {
    expect(thumbSrc(IMG)).toBe(`/api/thumb?src=${encodeURIComponent(IMG)}`);
  });
  it("Instagram/TikTok/YouTube hosts keep working", () => {
    for (const u of [
      "https://x.cdninstagram.com/a.jpg",
      "https://p16.tiktokcdn.com/a.jpg",
      "https://i.ytimg.com/vi/x/hq.jpg",
    ]) {
      expect(isAllowedThumbHost(u)).toBe(true);
    }
  });
});

describe("fallback component (source-level)", () => {
  const src = read("src/components/ui/video-thumb.tsx");
  it("has onError + pre-hydration failure handling — no broken-image state", () => {
    expect(src).toContain("onError={() => setFailed(true)}");
    expect(src).toContain("naturalWidth === 0");
  });
  it("Facebook fallback is intentional (labeled, platform-tinted)", () => {
    expect(src).toContain("Facebook Reel");
    expect(src).toContain("facebook:");
  });
});
