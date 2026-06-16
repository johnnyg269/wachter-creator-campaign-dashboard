// SocialCrawl over-import + Jan-1970 date fix.
//
// Covers: the robust date parser (Unix seconds/ms/ISO → ISO, invalid → null,
// NEVER Jan 1970), SocialCrawl normalize using it, the campaign-eligibility
// filter (epoch/pre-campaign/unassigned excluded; seeds & assigned kept), and an
// integration test driving the REAL pipeline to prove refresh is tracked-only
// (unmatched profile-feed items ignored, never imported), Facebook public plays
// still update matched videos, and totals exclude the unmatched content.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseTimestamp } from "@/lib/apify/normalize";
import {
  campaignStartMs,
  ineligibilityReason,
  isCampaignEligible,
} from "@/lib/eligibility";
import { SocialCrawlProvider } from "@/lib/providers/socialcrawl-provider";
import type { NormalizedVideo, PlatformProfile, Platform } from "@/lib/types";
import { useTmpCwd, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const yearOf = (iso: string | null) => (iso ? new Date(iso).getUTCFullYear() : null);

// ── 1) Date parser ────────────────────────────────────────────────────────────
describe("parseTimestamp — Unix sec/ms/ISO → ISO, invalid → null, never Jan 1970", () => {
  it("Unix SECONDS (number) → correct modern ISO (the SocialCrawl shape)", () => {
    const iso = parseTimestamp(1781569866); // SocialCrawl published_at
    expect(yearOf(iso)).toBe(2026);
    expect(iso).not.toMatch(/^1970/);
  });
  it("Unix MILLISECONDS (number) → correct modern ISO", () => {
    expect(yearOf(parseTimestamp(1781569866000))).toBe(2026);
  });
  it("10-digit string (seconds) and 13-digit string (millis)", () => {
    expect(yearOf(parseTimestamp("1781569866"))).toBe(2026);
    expect(yearOf(parseTimestamp("1781569866000"))).toBe(2026);
  });
  it("ISO string passes through", () => {
    expect(parseTimestamp("2026-06-10T00:00:00.000Z")).toBe("2026-06-10T00:00:00.000Z");
  });
  it("null / undefined / empty → null", () => {
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
    expect(parseTimestamp("")).toBeNull();
  });
  it("garbage string → null (not a date)", () => {
    expect(parseTimestamp("not a date")).toBeNull();
  });
  it("a small/bad number does NOT become Jan 1970 — it becomes null", () => {
    expect(parseTimestamp(123)).toBeNull();
    expect(parseTimestamp("123")).toBeNull();
    expect(parseTimestamp(1_000_000)).toBeNull(); // would be Jan 1970 if read as ms
  });
  it("a pre-2005 date STRING (incl. literal 1970) → null (floor applies to all branches)", () => {
    expect(parseTimestamp("1970-01-01T00:00:00Z")).toBeNull();
    expect(parseTimestamp("1970-01-01")).toBeNull();
    expect(parseTimestamp("2001-09-11")).toBeNull();
  });
  it("a valid recent date-only string still parses", () => {
    expect(yearOf(parseTimestamp("2026-06-10"))).toBe(2026);
  });
});

// ── 2) SocialCrawl normalize uses the parser ───────────────────────────────────
describe("SocialCrawl normalize — seconds date never becomes 1970; FB plays kept", () => {
  beforeEach(() => (process.env.SOCIALCRAWL_API_KEY = "sc_test"));
  afterEach(() => {
    delete process.env.SOCIALCRAWL_API_KEY;
    vi.unstubAllGlobals();
  });
  const profile = (platform: PlatformProfile["platform"]): PlatformProfile => ({
    id: "p1",
    campaignId: "c1",
    platform,
    profileUrl: `https://www.${platform}.com/cybernick0x`,
    handle: "cybernick0x",
    externalProfileId: null,
    lastDiscoveredAt: null,
    status: "live",
  });
  function stub(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response),
    );
  }

  it("Instagram published_at as Unix seconds → 2026 ISO (not Jan 1970)", async () => {
    stub({
      data: {
        reels: [
          {
            post: {
              id: "DZoG",
              url: "https://www.instagram.com/reel/DZoG-pWFObe/",
              content: { text: "x", thumbnail_url: "t" },
              engagement: { views: 100 },
              published_at: 1781569866, // SECONDS
            },
          },
        ],
      },
      credits_used: 1,
      cached: false,
    });
    const out = await new SocialCrawlProvider("instagram").fetchPlatform!(
      profile("instagram"),
      [],
      new Date(),
    );
    expect(yearOf(out.videos[0].publishedAt)).toBe(2026);
    expect(out.videos[0].publishedAt).not.toMatch(/^1970/);
  });

  it("Facebook still maps engagement.views as PUBLIC plays", async () => {
    stub({
      data: {
        reels: [
          {
            post: {
              id: "1361860342502757",
              url: "https://www.facebook.com/reel/1361860342502757",
              content: { text: "x" },
              engagement: { views: 128000 },
              published_at: 1781569866,
            },
          },
        ],
      },
      credits_used: 1,
      cached: false,
    });
    const out = await new SocialCrawlProvider("facebook").fetchPlatform!(
      profile("facebook"),
      [],
      new Date(),
    );
    expect(out.videos[0].views).toBe(128000);
    expect(yearOf(out.videos[0].publishedAt)).toBe(2026);
  });
});

// ── 3) Campaign eligibility ────────────────────────────────────────────────────
describe("campaign eligibility filter", () => {
  beforeEach(() => (process.env.CAMPAIGN_START_DATE_ET = "2026-06-08"));
  afterEach(() => delete process.env.CAMPAIGN_START_DATE_ET);

  const base = {
    platform: "instagram" as Platform,
    originalUrl: "https://www.instagram.com/reel/ABC/",
    publishedAt: "2026-06-10T00:00:00.000Z",
    isSeed: false,
    episodeGroupId: null as string | null,
  };
  const start = () => campaignStartMs();

  it("a valid, on-or-after-start, unassigned video is eligible", () => {
    expect(ineligibilityReason(base, start())).toBeNull();
  });
  it("a seed is always eligible (even with a bad date)", () => {
    expect(
      ineligibilityReason({ ...base, isSeed: true, publishedAt: "1970-01-21T00:00:00.000Z" }, start()),
    ).toBeNull();
  });
  it("a Jan-1970 / epoch date is excluded (date_invalid) — even if assigned", () => {
    expect(
      ineligibilityReason(
        { ...base, publishedAt: "1970-01-21T14:52:49.866Z", episodeGroupId: "ep-real" },
        start(),
        "unassigned-1",
      ),
    ).toBe("date_invalid");
  });
  it("content published before the campaign start is excluded", () => {
    expect(ineligibilityReason({ ...base, publishedAt: "2026-06-01T00:00:00.000Z" }, start())).toBe(
      "before_campaign_start",
    );
  });
  it("a record assigned to a REAL episode (valid date) is eligible", () => {
    expect(
      ineligibilityReason({ ...base, episodeGroupId: "ep-real" }, start(), "unassigned-1"),
    ).toBeNull();
  });
  it("the 'Other / unassigned' bucket counts as unassigned (excluded if date is bad)", () => {
    expect(
      ineligibilityReason(
        { ...base, publishedAt: null, episodeGroupId: "unassigned-1" },
        start(),
        "unassigned-1",
      ),
    ).toBe("date_missing");
  });
  it("a missing canonical URL is excluded", () => {
    expect(ineligibilityReason({ ...base, originalUrl: null }, start())).toBe("no_canonical_url");
  });

  it("filtering a mixed list keeps only eligible campaign videos (totals recalc)", () => {
    const list = [
      { ...base, originalUrl: "u-legit" }, // valid recent → keep
      { ...base, originalUrl: "u-1970", publishedAt: "1970-01-21T00:00:00.000Z" }, // epoch → drop
      { ...base, originalUrl: "u-old", publishedAt: "2026-06-01T00:00:00.000Z" }, // pre-start → drop
      { ...base, originalUrl: "u-seed", isSeed: true, publishedAt: null }, // seed → keep
    ];
    const kept = list.filter((v) => isCampaignEligible(v, start(), null)).map((v) => v.originalUrl);
    expect(kept).toEqual(["u-legit", "u-seed"]);
  });
});

// ── 4) Integration: tracked-only refresh (real pipeline, mocked registry) ──────
const ctrl = vi.hoisted(() => ({
  byPlatform: {} as Record<string, () => Promise<unknown>>,
}));
vi.mock("@/lib/providers/registry", () => {
  const ready = (platform: string) => ({
    provider: {
      providerType: "socialcrawl" as const,
      supportsComments: false,
      supportsDiscovery: true,
      fetchPlatform: async () =>
        ctrl.byPlatform[platform]
          ? ctrl.byPlatform[platform]()
          : { videos: [], commentsByVideo: {}, attempts: [] },
    },
    readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
    config: null,
  });
  const resolveProvider = async (platform: string) => ready(platform);
  const resolveAllProviders = async () => ({
    tiktok: await ready("tiktok"),
    youtube: await ready("youtube"),
    instagram: await ready("instagram"),
    facebook: await ready("facebook"),
  });
  return { resolveProvider, resolveAllProviders };
});

import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { getDashboardData } from "@/lib/queries";
import { getStore } from "@/lib/store";

const nv = (over: Partial<NormalizedVideo>): NormalizedVideo => ({
  platform: "tiktok",
  originalUrl: "https://example.com/x",
  externalVideoId: null,
  title: null,
  caption: null,
  thumbnailUrl: null,
  publishedAt: "2026-06-12T00:00:00.000Z",
  authorName: null,
  authorHandle: null,
  views: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  bookmarks: null,
  rawJson: { source: "socialcrawl" },
  ...over,
});

describe("tracked-only refresh (integration, real pipeline)", () => {
  let tmp: TmpCwd;
  const resetStore = () =>
    ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    resetStore();
    ctrl.byPlatform = {};
    process.env.CAMPAIGN_START_DATE_ET = "2026-06-08";
  });
  afterEach(async () => {
    resetStore();
    delete process.env.CAMPAIGN_START_DATE_ET;
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
    await tmp.cleanup();
  });

  it("updates tracked videos only; ignores unmatched feed items; FB plays update; totals exclude unmatched", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);

    const tt = await store.insertVideo({
      campaignId: campaign.id,
      platform: "tiktok",
      profileId: null,
      originalUrl: "https://www.tiktok.com/@cybernick0x/video/111",
      externalVideoId: "111",
      title: "Tracked TT",
      caption: null,
      thumbnailUrl: null,
      publishedAt: "2026-06-10T00:00:00.000Z",
      firstTrackedAt: "2026-06-10T00:00:00.000Z",
      lastRefreshedAt: null,
      status: "active",
      episodeGroupId: null,
      sourceStatus: "live",
      errorMessage: null,
      hidden: false,
      isSeed: false,
      rawJson: null,
    });
    const fb = await store.insertVideo({
      campaignId: campaign.id,
      platform: "facebook",
      profileId: null,
      originalUrl: "https://www.facebook.com/reel/222",
      externalVideoId: "222",
      title: "Tracked FB",
      caption: null,
      thumbnailUrl: null,
      publishedAt: "2026-06-10T00:00:00.000Z",
      firstTrackedAt: "2026-06-10T00:00:00.000Z",
      lastRefreshedAt: null,
      status: "active",
      episodeGroupId: null,
      sourceStatus: "live",
      errorMessage: null,
      hidden: false,
      isSeed: false,
      rawJson: null,
    });

    const countBefore = (await store.listVideos({ includeHidden: true })).length;

    // TikTok feed: the tracked video + two unmatched profile reels (one recent,
    // one pre-campaign). Only the tracked one must be updated.
    ctrl.byPlatform.tiktok = async () => ({
      videos: [
        nv({ originalUrl: "https://www.tiktok.com/@cybernick0x/video/111", externalVideoId: "111", views: 1000 }),
        nv({ originalUrl: "https://www.tiktok.com/@cybernick0x/video/999", externalVideoId: "999", views: 50000, publishedAt: "2026-06-14T00:00:00.000Z" }),
        nv({ originalUrl: "https://www.tiktok.com/@cybernick0x/video/777", externalVideoId: "777", views: 80000, publishedAt: "2026-06-01T00:00:00.000Z" }),
      ],
      commentsByVideo: {},
      attempts: [],
    });
    // Facebook feed: the tracked reel with PUBLIC plays.
    ctrl.byPlatform.facebook = async () => ({
      videos: [nv({ platform: "facebook", originalUrl: "https://www.facebook.com/reel/222", externalVideoId: "222", views: 128000 })],
      commentsByVideo: {},
      attempts: [],
    });

    await runRefresh("script");

    // No new videos created — unmatched feed items were ignored.
    const after = await store.listVideos({ includeHidden: true });
    expect(after.length).toBe(countBefore);
    expect(after.find((v) => v.externalVideoId === "999")).toBeUndefined();
    expect(after.find((v) => v.externalVideoId === "777")).toBeUndefined();

    // Tracked videos got their snapshots.
    const ttSnaps = await store.listSnapshots(tt.id);
    const fbSnaps = await store.listSnapshots(fb.id);
    expect(ttSnaps.at(-1)?.views).toBe(1000);
    expect(fbSnaps.at(-1)?.views).toBe(128000); // FB public plays

    // Totals reflect only the tracked videos (50000 + 80000 unmatched excluded).
    const dash = await getDashboardData("all");
    expect(dash.kpis.totalViews).toBe(1000 + 128000);
  });

  it("aggregate trend excludes a quarantined video's snapshots (not just KPIs)", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const mkVid = async (over: Record<string, unknown>) =>
      store.insertVideo({
        campaignId: campaign.id,
        platform: "tiktok",
        profileId: null,
        externalVideoId: null,
        title: "v",
        caption: null,
        thumbnailUrl: null,
        firstTrackedAt: "2026-06-10T00:00:00.000Z",
        lastRefreshedAt: "2026-06-15T00:00:00.000Z",
        status: "active",
        episodeGroupId: null,
        sourceStatus: "live",
        errorMessage: null,
        hidden: false,
        isSeed: false,
        rawJson: null,
        ...over,
      } as Parameters<typeof store.insertVideo>[0]);

    // Eligible (valid recent date) + quarantined (epoch date) — both with snaps.
    const good = await mkVid({ originalUrl: "https://www.tiktok.com/@x/video/eligible", publishedAt: "2026-06-12T00:00:00.000Z" });
    const bad = await mkVid({ originalUrl: "https://www.tiktok.com/@x/video/quarantined", publishedAt: "1970-01-21T00:00:00.000Z" });
    const cap = new Date(Date.now() - 3_600_000).toISOString();
    await store.addSnapshot({ videoId: good.id, capturedAt: cap, views: 1000, likes: null, comments: null, shares: null, saves: null, bookmarks: null, engagementRate: null, rawJson: null });
    await store.addSnapshot({ videoId: bad.id, capturedAt: cap, views: 50000, likes: null, comments: null, shares: null, saves: null, bookmarks: null, engagementRate: null, rawJson: null });

    const dash = await getDashboardData("all");
    // The quarantined 50,000-view snapshot must not inflate the trend line.
    const maxTrend = Math.max(0, ...dash.trend.map((p) => p.views ?? 0));
    expect(maxTrend).toBeLessThanOrEqual(1000);
    expect(dash.kpis.totalViews).toBe(1000);
  });
});

// ── 5) Safety: no secrets / provider internals / actor IDs leaked ──────────────
describe("safety — review queue exposes no secrets / internals / actor IDs", () => {
  it("eligibility module is pure config — no keys or vendor internals", () => {
    const e = read("src/lib/eligibility.ts");
    expect(e).not.toMatch(/sc_[A-Za-z0-9]{20,}/);
    expect(e).not.toMatch(/apify|actorId|x-api-key/i);
  });
  it("admin review-queue component carries no key/actorId/provider-internal fields", () => {
    const c = read("src/app/admin/review-queue.tsx");
    expect(c).not.toMatch(/sc_[A-Za-z0-9]{20,}/);
    expect(c).not.toMatch(/actorId|providerType|x-api-key/);
  });
  it("QuarantinedVideoDiag exposes no secret-bearing field", () => {
    const q = read("src/lib/queries.ts");
    const start = q.indexOf("interface QuarantinedVideoDiag");
    const block = q.slice(start, q.indexOf("}", start));
    expect(block).not.toMatch(/\bapi[_]?key\s*:/i);
    expect(block).not.toMatch(/\bactorId\s*:/i);
    expect(block).not.toMatch(/\bsecret\s*:/i);
    // "source" is a coarse provenance bucket, never a vendor name.
    expect(block).toContain('"socialcrawl" | "other" | "collector"');
  });
});
