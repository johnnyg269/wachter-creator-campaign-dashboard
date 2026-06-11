import { describe, expect, it } from "vitest";
import { isAllowedThumbHost, thumbSrc } from "@/lib/thumb-proxy";

describe("isAllowedThumbHost", () => {
  it("allows social CDN hosts", () => {
    expect(isAllowedThumbHost("https://scontent-iad6-1.cdninstagram.com/v/t51/x.jpg")).toBe(true);
    expect(isAllowedThumbHost("https://scontent-xxc1-1.xx.fbcdn.net/v/t15/y.jpg")).toBe(true);
    expect(isAllowedThumbHost("https://p16-sign-va.tiktokcdn.com/obj/z.webp")).toBe(true);
    expect(isAllowedThumbHost("https://i.ytimg.com/vi/abc/hqdefault.jpg")).toBe(true);
  });
  it("rejects everything else (no open proxy)", () => {
    expect(isAllowedThumbHost("https://evil.example.com/x.jpg")).toBe(false);
    expect(isAllowedThumbHost("https://cdninstagram.com.evil.com/x.jpg")).toBe(false);
    expect(isAllowedThumbHost("http://scontent.cdninstagram.com/x.jpg")).toBe(false); // http
    expect(isAllowedThumbHost("not a url")).toBe(false);
    expect(isAllowedThumbHost("file:///etc/passwd")).toBe(false);
  });
});

describe("thumbSrc", () => {
  it("routes CDN images through the proxy", () => {
    const url = "https://scontent-dfw5-2.cdninstagram.com/v/t51/img.jpg?ig_cache_key=abc";
    expect(thumbSrc(url)).toBe(`/api/thumb?src=${encodeURIComponent(url)}`);
  });
  it("passes ordinary https images straight through", () => {
    expect(thumbSrc("https://example.com/poster.png")).toBe("https://example.com/poster.png");
  });
  it("returns null for null/empty/garbage", () => {
    expect(thumbSrc(null)).toBeNull();
    expect(thumbSrc(undefined)).toBeNull();
    expect(thumbSrc("")).toBeNull();
    expect(thumbSrc("data:image/png;base64,xxxx")).toBeNull();
  });
});
