// Multi-platform comment ingestion via SocialCrawl /{platform}/post/comments
// (restored after the Apify→SocialCrawl migration). YouTube keeps the Data API.
// No Apify. Comment TEXT is real (never faked); empty/failed pulls preserve LKG.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocialCrawlProvider } from "@/lib/providers/socialcrawl-provider";
import type { Platform, Video } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

const vid = (platform: Platform, over: Partial<Video> = {}): Video => ({
  id: "v1", campaignId: "c1", platform, profileId: null,
  originalUrl: `https://www.${platform}.com/x/501`, externalVideoId: "501",
  title: null, caption: null, thumbnailUrl: null, publishedAt: null,
  firstTrackedAt: "2026-06-12T00:00:00.000Z", lastRefreshedAt: null, status: "active",
  episodeGroupId: null, sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false,
  rawJson: null, ...over,
});

// A SocialCrawl comments envelope: data.items[].comment
const commentsEnvelope = (comments: unknown[], total = comments.length, cursor: string | null = null) => ({
  success: true,
  data: { items: comments.map((comment) => ({ comment })), total, next_cursor: cursor },
  credits_used: 1,
  cached: false,
});

const stubByUrl = (handler: (url: string) => unknown) =>
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
    ok: true, status: 200, json: async () => handler(String(url)),
  }) as unknown as Response));

beforeEach(() => (process.env.SOCIALCRAWL_API_KEY = "sc_test"));
afterEach(() => { delete process.env.SOCIALCRAWL_API_KEY; vi.unstubAllGlobals(); });

// ── getVideoComments: parse the unified comment shape per platform ─────────────
describe("SocialCrawl getVideoComments parses comment TEXT", () => {
  it("TikTok: unix-seconds published_at parses to the real year (never 1970)", async () => {
    stubByUrl(() => commentsEnvelope([
      { id: "c1", text: "first!", author: { username: "u1", display_name: "User One", verified: false }, engagement: { likes: 3, replies: 1 }, flags: { deleted: false }, published_at: 1781568000 },
    ]));
    const out = await new SocialCrawlProvider("tiktok").getVideoComments(vid("tiktok"));
    expect(out).toHaveLength(1);
    expect(out[0].externalCommentId).toBe("c1");
    expect(out[0].text).toBe("first!");
    expect(out[0].authorName).toBe("User One");
    expect(out[0].likes).toBe(3);
    expect(out[0].replyCount).toBe(1);
    expect(out[0].postedAt).not.toBeNull();
    expect(new Date(out[0].postedAt!).getUTCFullYear()).toBe(2026); // not 1970
  });

  it("Instagram: string published_at + falls back to username when no display_name", async () => {
    stubByUrl(() => commentsEnvelope([
      { id: "ig1", text: "love this", author: { username: "grant", display_name: null }, engagement: { likes: 2, replies: null }, flags: { deleted: false }, published_at: "2026-06-18T23:33:47.000Z" },
    ]));
    const out = await new SocialCrawlProvider("instagram").getVideoComments(vid("instagram"));
    expect(out[0].authorName).toBe("grant");
    expect(out[0].replyCount).toBeNull();
    expect(new Date(out[0].postedAt!).getUTCFullYear()).toBe(2026);
  });

  it("Facebook: returns multiple real comments", async () => {
    stubByUrl(() => commentsEnvelope([
      { id: "fb1", text: "great reel", author: { display_name: "Steve Fish" }, engagement: { likes: 0, replies: 0 }, flags: { deleted: false }, published_at: "2026-06-19T02:39:07.000Z" },
      { id: "fb2", text: "🔥", author: { display_name: "Jane" }, engagement: { likes: 5, replies: 2 }, flags: { deleted: false }, published_at: "2026-06-19T02:40:00.000Z" },
    ]));
    const out = await new SocialCrawlProvider("facebook").getVideoComments(vid("facebook"));
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.externalCommentId)).toEqual(["fb1", "fb2"]);
  });

  it("skips deleted and empty comments (never stores a placeholder)", async () => {
    stubByUrl(() => commentsEnvelope([
      { id: "d1", text: "gone", flags: { deleted: true }, published_at: "2026-06-18T00:00:00Z" },
      { id: "e1", text: "   ", flags: { deleted: false }, published_at: "2026-06-18T00:00:00Z" },
      { id: "ok", text: "real", flags: { deleted: false }, published_at: "2026-06-18T00:00:00Z" },
    ]));
    const out = await new SocialCrawlProvider("tiktok").getVideoComments(vid("tiktok"));
    expect(out).toHaveLength(1);
    expect(out[0].externalCommentId).toBe("ok");
  });

  it("returns [] on provider failure (preserves last-known-good, never wipes)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response));
    const out = await new SocialCrawlProvider("tiktok").getVideoComments(vid("tiktok"));
    expect(out).toEqual([]);
  });
});

// ── fetchPlatform: populate commentsByVideo only on the comment cycle ──────────
describe("SocialCrawl fetchPlatform comment wiring", () => {
  const profile = { id: "p1", campaignId: "c1", platform: "tiktok" as const, profileUrl: "https://www.tiktok.com/@cybernick0x", handle: "cybernick0x", externalProfileId: null, lastDiscoveredAt: null, status: "live" as const };
  const profileEnvelope = () => ({
    success: true,
    data: { items: [{ post: { id: "501", url: "https://www.tiktok.com/@cybernick0x/video/501", engagement: { views: 100, comments: 2 }, content: { text: "x" }, published_at: 1781568000 } }] },
    credits_used: 1, cached: false,
  });
  const route = (url: string) =>
    url.includes("/post/comments")
      ? commentsEnvelope([{ id: "c1", text: "hi", author: { username: "u" }, engagement: { likes: 1, replies: 0 }, flags: { deleted: false }, published_at: 1781568000 }])
      : profileEnvelope();

  it("populates commentsByVideo (keyed by externalVideoId) when wantComments", async () => {
    stubByUrl(route);
    const res = await new SocialCrawlProvider("tiktok").fetchPlatform!(profile, [vid("tiktok")], new Date(), { wantComments: true });
    expect(res.commentsByVideo["501"]).toBeDefined();
    expect(res.commentsByVideo["501"][0].text).toBe("hi");
    expect(res.attempts.some((a) => a.kind === "comments" && a.success)).toBe(true);
  });

  it("respects the in-run commentBudget (never overshoots the daily cap)", async () => {
    const fetchSpy = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => route(String(url)) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const tracked = [vid("tiktok", { id: "a", externalVideoId: "a", originalUrl: "https://www.tiktok.com/@x/video/a" }),
                     vid("tiktok", { id: "b", externalVideoId: "b", originalUrl: "https://www.tiktok.com/@x/video/b" }),
                     vid("tiktok", { id: "c", externalVideoId: "c", originalUrl: "https://www.tiktok.com/@x/video/c" })];
    const res = await new SocialCrawlProvider("tiktok").fetchPlatform!(profile, tracked, new Date(), { wantComments: true, commentBudget: 1 });
    const commentCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/post/comments")).length;
    expect(commentCalls).toBe(1); // budget of 1 → exactly one comment fetch
    expect(res.attempts.some((a) => a.kind === "comments" && /budget/.test(a.inputDescription))).toBe(true);
  });

  it("does NOT fetch comments when wantComments is false (metrics-only cycle)", async () => {
    const fetchSpy = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => route(String(url)) }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const res = await new SocialCrawlProvider("tiktok").fetchPlatform!(profile, [vid("tiktok")], new Date(), { wantComments: false });
    expect(res.commentsByVideo).toEqual({});
    expect(fetchSpy.mock.calls.every((c) => !String(c[0]).includes("/post/comments"))).toBe(true);
  });
});

// ── Safety: no Apify, no secrets, all platforms in the UI ─────────────────────
describe("comment ingestion safety + UI coverage", () => {
  it("the SocialCrawl provider never calls the Apify service for comments", () => {
    const src = read("src/lib/providers/socialcrawl-provider.ts");
    // (It may import the pure parseTimestamp util from ../apify/normalize, but
    //  must never touch the Apify provider/client/actor runner.)
    expect(src).not.toMatch(/apify-provider|apify\/client|runActor|ApifyProvider/);
    expect(src).toContain("/post/comments");
  });
  it("the comments endpoint sends the key only as a header, never in the URL/query", () => {
    const src = read("src/lib/providers/socialcrawl-provider.ts");
    expect(src).toContain('"x-api-key"');
    expect(src).not.toMatch(/post\/comments\?[^"]*key=/);
  });
  it("the Comments page filter lists ALL platforms (not just ones with data)", () => {
    const feed = read("src/app/comments/comment-feed.tsx");
    expect(feed).toMatch(/PLATFORMS\.map/);
    expect(feed).toMatch(/platformCounts\[/);
  });
  it("admin surfaces per-platform comment ingestion health", () => {
    expect(read("src/lib/queries.ts")).toContain("commentHealth");
    expect(read("src/app/admin/page.tsx")).toMatch(/Comment ingestion/);
  });
});
