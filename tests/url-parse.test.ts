import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  parseProfileUrl,
  parseVideoUrl,
  tiktokPublishedAtFromId,
} from "@/lib/url-parse";

describe("detectPlatform", () => {
  it("detects all four platforms from their hosts", () => {
    expect(detectPlatform("https://www.tiktok.com/@cybernick0x")).toBe("tiktok");
    expect(detectPlatform("https://vm.tiktok.com/ZT8abcdef/")).toBe("tiktok");
    expect(detectPlatform("https://www.youtube.com/shorts/CL62fTyvMOY")).toBe("youtube");
    expect(detectPlatform("https://youtu.be/CL62fTyvMOY")).toBe("youtube");
    expect(detectPlatform("https://www.instagram.com/reel/DZWaZjlggrV/")).toBe("instagram");
    expect(detectPlatform("https://www.facebook.com/reel/1268008372073152")).toBe("facebook");
    expect(detectPlatform("https://fb.watch/abc123/")).toBe("facebook");
  });

  it("returns null for non-platform hosts and malformed input", () => {
    expect(detectPlatform("https://example.com/video/123")).toBeNull();
    expect(detectPlatform("not a url")).toBeNull();
    expect(detectPlatform("")).toBeNull();
  });
});

describe("parseVideoUrl — TikTok", () => {
  const seedUrl = "https://www.tiktok.com/@cybernick0x/video/7649233656807968014";

  it("parses the seed campaign video URL", () => {
    expect(parseVideoUrl(seedUrl)).toEqual({
      platform: "tiktok",
      handle: "cybernick0x",
      externalVideoId: "7649233656807968014",
      canonicalUrl: seedUrl,
    });
  });

  it("canonicalizes a TikTok URL with tracking query params", () => {
    const parsed = parseVideoUrl(`${seedUrl}?is_from_webapp=1&sender_device=pc`);
    expect(parsed?.externalVideoId).toBe("7649233656807968014");
    expect(parsed?.canonicalUrl).toBe(seedUrl);
  });

  it("keeps platform but null id for a TikTok URL without a video path", () => {
    const parsed = parseVideoUrl("https://www.tiktok.com/@cybernick0x");
    expect(parsed?.platform).toBe("tiktok");
    expect(parsed?.externalVideoId).toBeNull();
  });
});

describe("parseVideoUrl — YouTube", () => {
  const canonical = "https://www.youtube.com/shorts/CL62fTyvMOY";

  it("parses the seed shorts URL", () => {
    expect(parseVideoUrl(canonical)).toEqual({
      platform: "youtube",
      handle: null,
      externalVideoId: "CL62fTyvMOY",
      canonicalUrl: canonical,
    });
  });

  it("parses youtu.be short links to the same id", () => {
    const parsed = parseVideoUrl("https://youtu.be/CL62fTyvMOY");
    expect(parsed?.externalVideoId).toBe("CL62fTyvMOY");
    expect(parsed?.canonicalUrl).toBe(canonical);
  });

  it("parses watch?v= form to the same id", () => {
    const parsed = parseVideoUrl("https://www.youtube.com/watch?v=CL62fTyvMOY");
    expect(parsed?.externalVideoId).toBe("CL62fTyvMOY");
    expect(parsed?.canonicalUrl).toBe(canonical);
  });
});

describe("parseVideoUrl — Instagram", () => {
  const canonical = "https://www.instagram.com/reel/DZWaZjlggrV/";

  it("parses the /reel/<code>/ form", () => {
    expect(parseVideoUrl(canonical)).toEqual({
      platform: "instagram",
      handle: null,
      externalVideoId: "DZWaZjlggrV",
      canonicalUrl: canonical,
    });
  });

  it("parses the /<handle>/reel/<code>/ form and extracts the handle", () => {
    const parsed = parseVideoUrl("https://www.instagram.com/cybernick0x/reel/DZWaZjlggrV/");
    expect(parsed?.externalVideoId).toBe("DZWaZjlggrV");
    expect(parsed?.handle).toBe("cybernick0x");
    expect(parsed?.canonicalUrl).toBe(canonical);
  });
});

describe("parseVideoUrl — Facebook", () => {
  it("parses the seed reel URL", () => {
    expect(parseVideoUrl("https://www.facebook.com/reel/1268008372073152")).toEqual({
      platform: "facebook",
      handle: null,
      externalVideoId: "1268008372073152",
      canonicalUrl: "https://www.facebook.com/reel/1268008372073152",
    });
  });

  it("parses watch?v=<numeric> URLs", () => {
    const parsed = parseVideoUrl("https://www.facebook.com/watch?v=1268008372073152");
    expect(parsed?.externalVideoId).toBe("1268008372073152");
  });
});

describe("parseVideoUrl — bad input", () => {
  it("returns null for unknown hosts and garbage", () => {
    expect(parseVideoUrl("https://example.com/shorts/CL62fTyvMOY")).toBeNull();
    expect(parseVideoUrl("not a url at all")).toBeNull();
    expect(parseVideoUrl("")).toBeNull();
  });
});

describe("parseProfileUrl", () => {
  it("parses the TikTok seed profile", () => {
    expect(parseProfileUrl("https://www.tiktok.com/@cybernick0x")).toEqual({
      platform: "tiktok",
      handle: "cybernick0x",
      externalProfileId: null,
    });
  });

  it("parses the YouTube @handle profile (with /shorts suffix)", () => {
    expect(parseProfileUrl("https://www.youtube.com/@cybernick0x/shorts")).toEqual({
      platform: "youtube",
      handle: "cybernick0x",
      externalProfileId: null,
    });
  });

  it("parses YouTube channel-id URLs", () => {
    const parsed = parseProfileUrl("https://www.youtube.com/channel/UCabc123_DEF");
    expect(parsed?.externalProfileId).toBe("UCabc123_DEF");
    expect(parsed?.handle).toBeNull();
  });

  it("parses the Instagram seed profile, with and without trailing slash", () => {
    expect(parseProfileUrl("https://www.instagram.com/cybernick0x")?.handle).toBe("cybernick0x");
    expect(parseProfileUrl("https://www.instagram.com/cybernick0x/")?.handle).toBe("cybernick0x");
  });

  it("parses the Facebook /people/ seed profile with numeric id", () => {
    expect(
      parseProfileUrl("https://www.facebook.com/people/Cybernick0x/61585540862384/?sk=reels_tab"),
    ).toEqual({
      platform: "facebook",
      handle: "Cybernick0x",
      externalProfileId: "61585540862384",
    });
  });

  it("parses Facebook vanity profiles", () => {
    expect(parseProfileUrl("https://www.facebook.com/cybernick0x")).toEqual({
      platform: "facebook",
      handle: "cybernick0x",
      externalProfileId: null,
    });
  });

  it("returns null for non-platform URLs", () => {
    expect(parseProfileUrl("https://example.com/cybernick0x")).toBeNull();
    expect(parseProfileUrl("::::")).toBeNull();
  });
});

describe("tiktokPublishedAtFromId", () => {
  it("decodes the seed video id to its June 2026 publish time", () => {
    const iso = tiktokPublishedAtFromId("7649233656807968014");
    expect(iso).toBe("2026-06-09T03:33:15.000Z");
    expect(new Date(iso as string).getUTCFullYear()).toBe(2026);
  });

  it("returns null for garbage", () => {
    expect(tiktokPublishedAtFromId("not-a-number")).toBeNull();
    expect(tiktokPublishedAtFromId("")).toBeNull();
    // Too short to be a snowflake
    expect(tiktokPublishedAtFromId("12345")).toBeNull();
    // Timestamp far in the future (> year 2096)
    expect(tiktokPublishedAtFromId("99999999999999999999")).toBeNull();
    // Timestamp before TikTok existed (< 2014)
    expect(tiktokPublishedAtFromId("4294967296000000000")).toBeNull();
  });
});
