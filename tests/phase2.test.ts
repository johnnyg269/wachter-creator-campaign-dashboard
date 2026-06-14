// Phase-2 additions: "watcher" misspelling tagging, new intent tags, sparse
// trend detection, source-capability wording, IG thumbnail normalization, and
// production env validation.

import { afterEach, describe, expect, it } from "vitest";
import { tagComment } from "@/lib/intel/keywords";
import { isSparseTrend, type TrendPoint } from "@/lib/metrics";
import { describeSourceCapability, type PlatformHealth, type PlatformStats } from "@/lib/queries";
import { normalizeVideoItem } from "@/lib/apify/normalize";
import { checkProductionEnv } from "@/lib/env-check";
import { stashEnv } from "./helpers";

describe("Wachter misspelling tagging", () => {
  it('tags "watcher" / "wachter" / "wachter" variants as wachter mentions', () => {
    expect(tagComment("So did you get a job with watcher ?")).toContain("wachter");
    expect(tagComment("Wachter looks like a great company")).toContain("wachter");
    expect(tagComment("is wachter hiring?")).toContain("wachter");
  });
  it("does not over-match unrelated words", () => {
    expect(tagComment("I love watching these videos")).not.toContain("wachter");
  });
  it("tags new intent phrases", () => {
    expect(tagComment("How do I apply for this?")).toContain("apply");
    expect(tagComment("can you help me get started")).toContain("help request");
    expect(tagComment("where is this located?")).toContain("location");
    expect(tagComment("what company is this?")).toContain("company");
  });
});

describe("isSparseTrend", () => {
  const pt = (views: number | null): TrendPoint => ({
    t: "2026-06-11T00:00:00.000Z",
    views,
    engagements: null,
    comments: null,
  });
  it("is sparse with <3 data points or a flat line", () => {
    expect(isSparseTrend([pt(null), pt(100), pt(200)])).toBe(true); // 2 points
    expect(isSparseTrend([pt(100), pt(100), pt(100)])).toBe(true); // flat
  });
  it("is not sparse with 3+ varying points", () => {
    expect(isSparseTrend([pt(100), pt(150), pt(220)])).toBe(false);
  });
});

describe("describeSourceCapability wording", () => {
  const ph = (over: Partial<PlatformHealth>): PlatformHealth => ({
    platform: "tiktok",
    providerType: "apify",
    sourceStatus: "live",
    statusDetail: null,
    lastSuccessfulRefreshAt: null,
    supportsComments: true,
    supportsDiscovery: true,
    ...over,
  });
  const stats = (views: number | null, comments: number | null = null): PlatformStats =>
    ({ platform: "tiktok", videoCount: 2, views, comments }) as PlatformStats;

  it("full-capability platform reads as live metrics + comments", () => {
    expect(describeSourceCapability(ph({}), stats(5000, 10)).summary).toBe(
      "Live metrics + comments",
    );
  });
  it("YouTube via API key reads as live metrics + comments", () => {
    const c = describeSourceCapability(
      ph({ platform: "youtube", providerType: "youtube_api", supportsComments: true }),
      stats(5000, 10),
      { youtubeKeySet: true },
    );
    expect(c.summary).toBe("Live metrics + comments");
  });
  it("YouTube via Apify without key suggests the API key, not a failure", () => {
    const c = describeSourceCapability(
      ph({ platform: "youtube", providerType: "apify", supportsComments: false }),
      stats(5000, 10),
      { youtubeKeySet: false },
    );
    expect(c.summary).toBe(
      "Live metrics + comment counts · add YouTube API key for comments",
    );
    expect(c.summary).not.toContain("comments unavailable");
  });
  it("Facebook with comment counts only says so — never the generic label", () => {
    const c = describeSourceCapability(
      ph({ platform: "facebook", supportsComments: false }),
      stats(null, 4),
    );
    expect(c.summary).toBe("Live engagement + comment counts · views unavailable");
    expect(c.summary).not.toContain("comments unavailable");
    expect(c.gaps).toContain("views unavailable");
  });
  it("platform with neither views nor any comment data names both gaps", () => {
    const c = describeSourceCapability(
      ph({ platform: "facebook", supportsComments: false }),
      stats(null, null),
    );
    expect(c.summary).toBe("Live engagement · views unavailable · comments unavailable");
  });
  it("disconnected platform surfaces the reason", () => {
    const c = describeSourceCapability(
      ph({ sourceStatus: "actor_not_configured", statusDetail: "Assign an actor" }),
      undefined,
    );
    expect(c.live).toBe(false);
    expect(c.summary).toBe("Assign an actor");
  });
});

describe("Instagram thumbnail normalization", () => {
  it("prefers displayUrl from the reel scraper output", () => {
    const n = normalizeVideoItem(
      {
        url: "https://www.instagram.com/reel/DZWaZjlggrV/",
        displayUrl: "https://scontent-dfw5-2.cdninstagram.com/v/t51/img.jpg",
        videoViewCount: 100,
      },
      "instagram",
    )!;
    expect(n.thumbnailUrl).toBe("https://scontent-dfw5-2.cdninstagram.com/v/t51/img.jpg");
  });
  it("falls back through alternative image fields", () => {
    for (const item of [
      { url: "https://www.instagram.com/reel/x/", thumbnailUrl: "https://a/1.jpg" },
      { url: "https://www.instagram.com/reel/x/", imageUrl: "https://a/2.jpg" },
      { url: "https://www.instagram.com/reel/x/", coverUrl: "https://a/3.jpg" },
      { url: "https://www.instagram.com/reel/x/", thumbnails: [{ url: "https://a/4.jpg" }] },
    ]) {
      const n = normalizeVideoItem(item, "instagram")!;
      expect(n.thumbnailUrl).toMatch(/^https:\/\/a\//);
    }
  });
  it("leaves thumbnail null (not broken) when nothing matches", () => {
    const n = normalizeVideoItem(
      { url: "https://www.instagram.com/reel/x/", videoViewCount: 5 },
      "instagram",
    )!;
    expect(n.thumbnailUrl).toBeNull();
  });
});

describe("checkProductionEnv", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("flags missing critical env as errors and soft gaps as warnings", () => {
    restore = stashEnv([
      "DATABASE_URL", "APIFY_TOKEN", "CRON_SECRET", "ADMIN_PASSWORD",
      "APIFY_TIKTOK_ACTOR_ID", "APIFY_INSTAGRAM_ACTOR_ID",
      "APIFY_FACEBOOK_ACTOR_ID", "APIFY_YOUTUBE_ACTOR_ID",
    ]);
    const result = checkProductionEnv();
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/CRON_SECRET/);
    expect(result.errors.join(" ")).toMatch(/ADMIN_PASSWORD/);
    expect(result.warnings.join(" ")).toMatch(/DATABASE_URL/);
    expect(result.warnings.join(" ")).toMatch(/APIFY_TOKEN/);
    // No secret VALUES ever appear in messages
    expect(JSON.stringify(result)).not.toMatch(/apify_api_/);
  });

  it("passes with a complete production env", () => {
    restore = stashEnv([]);
    const env = {
      ...process.env,
      DATABASE_URL: "postgresql://u:p@host:6543/db",
      APIFY_TOKEN: "apify_api_test",
      CRON_SECRET: "s",
      ADMIN_PASSWORD: "p",
      APIFY_TIKTOK_ACTOR_ID: "a",
      APIFY_INSTAGRAM_ACTOR_ID: "b",
      APIFY_FACEBOOK_ACTOR_ID: "c",
      APIFY_YOUTUBE_ACTOR_ID: "d",
    } as NodeJS.ProcessEnv;
    const saved = process.env;
    process.env = env;
    try {
      const result = checkProductionEnv(env);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    } finally {
      process.env = saved;
    }
  });
});
