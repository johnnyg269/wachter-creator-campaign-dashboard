// TikTok thumbnail resolver (SocialCrawl covers + HEIC proxy transcode) and the
// executive visual-polish changes (centered alerts badge, board-friendly Exec
// Summary, non-overflowing Growth-by-Platform card).

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocialCrawlProvider } from "@/lib/providers/socialcrawl-provider";
import type { NormalizedVideo, PlatformProfile } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── TikTok thumbnail picker (provider-level, via fetchPlatform stub) ───────────
describe("SocialCrawl TikTok thumbnail resolver", () => {
  beforeEach(() => (process.env.SOCIALCRAWL_API_KEY = "sc_test"));
  afterEach(() => {
    delete process.env.SOCIALCRAWL_API_KEY;
    vi.unstubAllGlobals();
  });
  const profile: PlatformProfile = {
    id: "p1", campaignId: "c1", platform: "tiktok",
    profileUrl: "https://www.tiktok.com/cybernick0x", handle: "cybernick0x",
    externalProfileId: null, lastDiscoveredAt: null, status: "live",
  };
  const stub = (post: Record<string, unknown>) =>
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { videos: [{ post }] }, credits_used: 1, cached: false }),
    }) as unknown as Response));
  const run = async () =>
    (await new SocialCrawlProvider("tiktok").fetchPlatform!(profile, [], new Date())).videos[0];

  const base = {
    id: "7650240034657848589",
    url: "https://www.tiktok.com/@cybernick0x/video/7650240034657848589",
    engagement: { views: 100 },
    published_at: 1781569866,
  };

  it("finds a real (renderable) cover from content.thumbnail_url", async () => {
    stub({ ...base, content: { text: "x", thumbnail_url: "https://p16.tiktokcdn-us.com/cover.jpg" } });
    expect((await run()).thumbnailUrl).toBe("https://p16.tiktokcdn-us.com/cover.jpg");
  });

  it("rejects HEIC covers (browser-unrenderable) → null, keeping last-known-good", async () => {
    stub({ ...base, content: { thumbnail_url: "https://cdn.tiktokcdn-us.com/x.heic?sig=1" } });
    expect((await run()).thumbnailUrl).toBeNull();
  });

  it("rejects the TikTok ~tplv .heic template cover", async () => {
    stub({ ...base, content: { thumbnail_url: "https://p16-common-sign.tiktokcdn-us.com/abc~tplv-tiktokx-cropcenter:300:400.heic?dr=9&x-signature=z" } });
    expect((await run()).thumbnailUrl).toBeNull();
  });

  it("falls back across cover fields when thumbnail_url is empty", async () => {
    stub({ ...base, content: { thumbnail_url: "", coverUrl: "https://cdn.tiktokcdn-us.com/cover2.jpg" } });
    expect((await run()).thumbnailUrl).toBe("https://cdn.tiktokcdn-us.com/cover2.jpg");
  });

  it("rejects the video file (media_urls) — never a thumbnail", async () => {
    stub({ ...base, content: { media_urls: "https://v16m.tiktokcdn-us.com/clip.mp4" } });
    expect((await run()).thumbnailUrl).toBeNull();
  });

  it("rejects placeholder/empty/non-URL covers → null (so last-known-good is kept)", async () => {
    stub({ ...base, content: { thumbnail_url: "https://cdn.x/placeholder.png", cover: "", image: "not-a-url" } });
    expect((await run()).thumbnailUrl).toBeNull();
  });
});

// ── Last-known-good preservation (integration, real pipeline) ──────────────────
const ctrl = vi.hoisted(() => ({ tiktok: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/providers/registry", () => {
  const ready = (platform: string) => ({
    provider: {
      providerType: "socialcrawl" as const, supportsComments: false, supportsDiscovery: true,
      fetchPlatform: async () =>
        platform === "tiktok" && ctrl.tiktok
          ? ctrl.tiktok()
          : { videos: [], commentsByVideo: {}, attempts: [] },
    },
    readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
    config: null,
  });
  const resolveProvider = async (p: string) => ready(p);
  const resolveAllProviders = async () => ({
    tiktok: await ready("tiktok"), youtube: await ready("youtube"),
    instagram: await ready("instagram"), facebook: await ready("facebook"),
  });
  return { resolveProvider, resolveAllProviders };
});

import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, type TmpCwd } from "./helpers";

const nv = (over: Partial<NormalizedVideo>): NormalizedVideo => ({
  platform: "tiktok", originalUrl: "https://www.tiktok.com/@x/video/501", externalVideoId: "501",
  title: null, caption: null, thumbnailUrl: null, publishedAt: "2026-06-12T00:00:00.000Z",
  authorName: null, authorHandle: null, views: 2000, likes: null, comments: null, shares: null,
  saves: null, bookmarks: null, rawJson: { source: "socialcrawl" }, ...over,
});

describe("TikTok thumbnail last-known-good (integration)", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => { tmp = await useTmpCwd(); reset(); ctrl.tiktok = null; process.env.CAMPAIGN_START_DATE_ET = "2026-06-08"; });
  afterEach(async () => {
    reset(); ctrl.tiktok = null; delete process.env.CAMPAIGN_START_DATE_ET;
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
    await tmp.cleanup();
  });

  it("a refresh with no usable thumbnail does NOT overwrite the stored one", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await store.insertVideo({
      campaignId: campaign.id, platform: "tiktok", profileId: null,
      originalUrl: "https://www.tiktok.com/@x/video/501", externalVideoId: "501",
      title: "Tracked", caption: null, thumbnailUrl: "https://cdn.tiktokcdn-us.com/GOOD.jpg",
      publishedAt: "2026-06-10T00:00:00.000Z", firstTrackedAt: "2026-06-10T00:00:00.000Z",
      lastRefreshedAt: "2026-06-12T00:00:00.000Z", status: "active", episodeGroupId: null,
      sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false, rawJson: null,
    });
    // SocialCrawl returns the tracked video with NO usable thumbnail this cycle.
    ctrl.tiktok = async () => ({ videos: [nv({ thumbnailUrl: null, views: 2500 })], commentsByVideo: {}, attempts: [] });
    await runRefresh("script");
    const after = await store.getVideo(v.id);
    expect(after?.thumbnailUrl).toBe("https://cdn.tiktokcdn-us.com/GOOD.jpg"); // preserved
  });
});

// ── Source-level: HEIC proxy transcode + visual polish ────────────────────────
describe("thumbnail proxy", () => {
  // TikTok's signed CDN blocks datacenter fetches, so server-side transcode is
  // not viable — we don't depend on sharp; HEIC covers are rejected upstream.
  it("does not depend on sharp / HEIC transcode", () => {
    expect(read("src/app/api/thumb/route.ts")).not.toContain("sharp");
    expect(read("package.json")).not.toMatch(/"sharp"\s*:/);
    expect(read("next.config.ts")).not.toMatch(/serverExternalPackages/);
  });
  it("keeps the TikTok CDN host allowlisted (Apify/IG/FB proxying still works)", () => {
    expect(read("src/lib/thumb-proxy.ts")).toContain(".tiktokcdn-us.com");
  });
});

describe("visual polish", () => {
  it("alerts badge centers its text (shared component + globals)", () => {
    const css = read("src/app/globals.css");
    const start = css.indexOf(".t-badge-dot {");
    const block = css.slice(start, css.indexOf("}", start));
    expect(block).toContain("inline-flex");
    expect(block).toContain("align-items: center");
    expect(block).toContain("justify-content: center");
    expect(read("src/components/ui/notification-badge.tsx")).toContain("items-center");
  });
  it("Executive Summary drops the confidence pill and the Leading Theme card", () => {
    const studio = read("src/app/reports/reports-studio.tsx");
    expect(studio).not.toContain("ConfidenceChip");
    expect(studio).not.toMatch(/Leading theme/i);
    expect(studio).toContain("Top growth driver");
    expect(studio).toMatch(/public Reel plays/i);
  });
  it("Growth-by-Platform card is bounded (shrink-0, not greedily flex-1) to avoid overflow", () => {
    const studio = read("src/app/reports/reports-studio.tsx");
    // The PlatformContribution card root is compact/shrink-0 now.
    expect(studio).toMatch(/shrink-0 rounded-2xl border px-7 py-4/);
  });
});
