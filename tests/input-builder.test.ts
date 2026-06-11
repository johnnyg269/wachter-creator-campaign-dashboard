import { describe, expect, it } from "vitest";
import {
  buildInputCandidates,
  genericInputCandidates,
  MAX_INPUT_ATTEMPTS,
} from "@/lib/apify/input-builder";

const TIKTOK_VIDEO = "https://www.tiktok.com/@cybernick0x/video/7649233656807968014";
const TIKTOK_PROFILE = "https://www.tiktok.com/@cybernick0x";

describe("known actors", () => {
  it("clockworks TikTok: video kind uses postURLs", () => {
    const [c] = buildInputCandidates("tiktok", "GdWCkxBtKWOsKjdch", "videos", {
      videoUrls: [TIKTOK_VIDEO],
      commentsPerPost: 10,
    });
    expect(c.input).toMatchObject({ postURLs: [TIKTOK_VIDEO], commentsPerPost: 10 });
    expect(c.input).toHaveProperty("shouldDownloadVideos", false);
  });
  it("clockworks TikTok: discover kind uses profiles + date filter", () => {
    const [c] = buildInputCandidates("tiktok", "GdWCkxBtKWOsKjdch", "discover", {
      profileUrl: TIKTOK_PROFILE,
      sinceIso: "2026-06-09T03:33:21.000Z",
      limit: 25,
    });
    expect(c.input).toMatchObject({
      profiles: ["cybernick0x"],
      oldestPostDateUnified: "2026-06-09",
      resultsPerPage: 25,
    });
  });
  it("free TikTok variant drops commentsPerPost", () => {
    const [c] = buildInputCandidates("tiktok", "OtzYfK1ndEGdwWFKQ", "videos", {
      videoUrls: [TIKTOK_VIDEO],
      commentsPerPost: 10,
    });
    expect(c.input).not.toHaveProperty("commentsPerPost");
  });
  it("instagram reel scraper uses username array (accepts URLs)", () => {
    const [c] = buildInputCandidates("instagram", "xMc5Ga1oCONPmWJIa", "videos", {
      videoUrls: ["https://www.instagram.com/reel/DZWaZjlggrV/"],
    });
    expect(c.input).toMatchObject({
      username: ["https://www.instagram.com/reel/DZWaZjlggrV/"],
      resultsLimit: 1,
    });
  });
  it("facebook posts scraper wraps startUrls in objects", () => {
    const [c] = buildInputCandidates("facebook", "KoJrdxJCTtpon81KY", "videos", {
      videoUrls: ["https://www.facebook.com/reel/1268008372073152"],
    });
    expect(c.input).toMatchObject({
      startUrls: [{ url: "https://www.facebook.com/reel/1268008372073152" }],
    });
  });
  it("youtube shorts scraper is channel-based", () => {
    const [c] = buildInputCandidates("youtube", "WT1BVWatl2aHVeFEH", "discover", {
      profileUrl: "https://www.youtube.com/@cybernick0x/shorts",
      sinceIso: "2026-06-09T00:00:00.000Z",
      limit: 30,
    });
    expect(c.input).toMatchObject({
      channels: ["https://www.youtube.com/@cybernick0x/shorts"],
      maxResultsShorts: 30,
      oldestPostDate: "2026-06-09",
    });
    // it cannot target individual video URLs
    expect(
      buildInputCandidates("youtube", "WT1BVWatl2aHVeFEH", "videos", { videoUrls: ["x"] }),
    ).toHaveLength(0);
  });
});

describe("unknown actors", () => {
  it("returns the generic pattern list in spec order", () => {
    const candidates = genericInputCandidates("videos", { videoUrls: ["https://a.example/v"] });
    expect(candidates[0].input).toEqual({ startUrls: [{ url: "https://a.example/v" }] });
    expect(candidates[1].input).toEqual({ startUrls: ["https://a.example/v"] });
    expect(candidates[2].input).toEqual({ directUrls: ["https://a.example/v"] });
    expect(candidates[3].input).toEqual({ urls: ["https://a.example/v"] });
    expect(candidates[4].input).toEqual({ url: "https://a.example/v" });
    expect(candidates[5].input).toEqual({ videoUrls: ["https://a.example/v"] });
    expect(candidates[6].input).toEqual({ postUrls: ["https://a.example/v"] });
  });
  it("buildInputCandidates falls back to generic patterns for unknown actor ids", () => {
    const candidates = buildInputCandidates("tiktok", "someUnknownActor", "videos", {
      videoUrls: [TIKTOK_VIDEO],
    });
    expect(candidates.length).toBeGreaterThanOrEqual(7);
  });
  it("caps retry attempts so we never hammer Apify", () => {
    expect(MAX_INPUT_ATTEMPTS).toBe(3);
  });
});

describe("admin override", () => {
  it("uses the override verbatim and alone", () => {
    const candidates = buildInputCandidates("tiktok", "GdWCkxBtKWOsKjdch", "videos", {
      videoUrls: [TIKTOK_VIDEO],
      override: { custom: true },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].input).toEqual({ custom: true });
  });
});
