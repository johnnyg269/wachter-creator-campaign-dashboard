import { describe, expect, it } from "vitest";
import {
  detectCapabilities,
  extractEmbeddedComments,
  normalizeCommentItem,
  normalizeVideoItem,
} from "@/lib/apify/normalize";

describe("normalizeVideoItem — clockworks TikTok shape", () => {
  const item = {
    id: "7649233656807968014",
    text: "One of the biggest major tech integrators invited me to their headquarters",
    webVideoUrl: "https://www.tiktok.com/@cybernick0x/video/7649233656807968014",
    playCount: 2416,
    diggCount: 42,
    commentCount: 3,
    shareCount: 1,
    collectCount: 4,
    createTimeISO: "2026-06-09T03:33:21.000Z",
    authorMeta: { name: "cybernick0x", nickName: "Cybernick0x" },
    videoMeta: { coverUrl: "https://cdn.example/cover.jpg" },
  };
  it("maps the full clockworks payload", () => {
    const n = normalizeVideoItem(item, "tiktok")!;
    expect(n.views).toBe(2416);
    expect(n.likes).toBe(42);
    expect(n.comments).toBe(3);
    expect(n.shares).toBe(1);
    expect(n.saves).toBe(4);
    expect(n.caption).toMatch(/tech integrators/);
    expect(n.thumbnailUrl).toBe("https://cdn.example/cover.jpg");
    expect(n.publishedAt).toBe("2026-06-09T03:33:21.000Z");
    expect(n.externalVideoId).toBe("7649233656807968014");
    expect(n.authorHandle).toBe("cybernick0x");
  });
});

describe("normalizeVideoItem — Instagram reel scraper shape", () => {
  const item = {
    shortCode: "DZWaZjlggrV",
    url: "https://www.instagram.com/reel/DZWaZjlggrV/",
    caption: "Headquarters visit",
    videoViewCount: 4514,
    likesCount: 160,
    commentsCount: 3,
    displayUrl: "https://cdn.example/ig.jpg",
    timestamp: "2026-06-09T03:36:14.000Z",
    ownerUsername: "cybernick0x",
    latestComments: [
      { id: "c1", ownerUsername: "fan1", text: "How do I sign up?", timestamp: "2026-06-09T05:00:00.000Z" },
    ],
  };
  it("maps metrics and embedded comments", () => {
    const n = normalizeVideoItem(item, "instagram")!;
    expect(n.views).toBe(4514);
    expect(n.likes).toBe(160);
    expect(n.comments).toBe(3);
    expect(n.shares).toBeNull(); // not exposed → unavailable, not 0
    const comments = extractEmbeddedComments(item);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("How do I sign up?");
    expect(comments[0].authorName).toBe("fan1");
  });
});

describe("normalizeVideoItem — Facebook posts scraper shape", () => {
  const item = {
    facebookUrl: "https://www.facebook.com/reel/1268008372073152",
    message: { text: "Day 21 of learning low voltage", ranges: [] },
    likers: { count: 28 },
    total_comment_count: 2,
    share_count_reduced: 1,
    creation_time: 1781136518,
    short_form_video_context: {
      playback_video: { preferred_thumbnail: { image: { uri: "https://cdn.example/fb.jpg" } } },
    },
  };
  it("maps nested GraphQL-style fields; views stay unavailable", () => {
    const n = normalizeVideoItem(item, "facebook")!;
    expect(n.views).toBeNull(); // FB reels don't expose views — NOT zero
    expect(n.likes).toBe(28);
    expect(n.comments).toBe(2);
    expect(n.shares).toBe(1);
    expect(n.caption).toBe("Day 21 of learning low voltage");
    expect(n.thumbnailUrl).toBe("https://cdn.example/fb.jpg");
    expect(n.publishedAt).toBe(new Date(1781136518 * 1000).toISOString());
    expect(n.externalVideoId).toBe("1268008372073152");
  });
});

describe("normalizeVideoItem — defensive behavior", () => {
  it("returns null for unrecognizable junk", () => {
    expect(normalizeVideoItem({ foo: "bar" }, "tiktok")).toBeNull();
  });
  it("coerces string numbers and never invents zeros", () => {
    const n = normalizeVideoItem(
      { url: "https://www.youtube.com/shorts/abc12345", viewCount: "814" },
      "youtube",
    )!;
    expect(n.views).toBe(814);
    expect(n.likes).toBeNull();
    expect(n.comments).toBeNull();
  });
  it("converts unix-second timestamps", () => {
    const n = normalizeVideoItem(
      { url: "https://www.tiktok.com/@x/video/123", createTime: 1781050000 },
      "tiktok",
    )!;
    expect(n.publishedAt).toBe(new Date(1781050000 * 1000).toISOString());
  });
});

describe("normalizeCommentItem", () => {
  it("maps common comment shapes", () => {
    const c = normalizeCommentItem({
      cid: "c-9",
      text: "Is the training paid?",
      uniqueId: "viewer42",
      diggCount: 12,
      replyCommentTotal: 2,
      createTimeISO: "2026-06-09T08:00:00.000Z",
    })!;
    expect(c.externalCommentId).toBe("c-9");
    expect(c.text).toBe("Is the training paid?");
    expect(c.likes).toBe(12);
    expect(c.replyCount).toBe(2);
  });
  it("returns null without text", () => {
    expect(normalizeCommentItem({ likes: 5 })).toBeNull();
  });
});

describe("detectCapabilities", () => {
  it("reports metadata/metrics/comments support", () => {
    const caps = detectCapabilities(
      [
        {
          url: "https://www.tiktok.com/@x/video/1",
          title: "t",
          playCount: 10,
          commentsDatasetUrl: "https://api.apify.com/v2/datasets/x/items",
        },
      ],
      "tiktok",
    );
    expect(caps.supportsMetadata).toBe(true);
    expect(caps.supportsMetrics).toBe(true);
    expect(caps.supportsComments).toBe(true); // via side dataset
    expect(caps.fields).toContain("playCount");
  });
  it("reports nothing for empty output", () => {
    const caps = detectCapabilities([], "tiktok");
    expect(caps.supportsMetadata).toBe(false);
    expect(caps.supportsMetrics).toBe(false);
    expect(caps.supportsComments).toBe(false);
  });
});
