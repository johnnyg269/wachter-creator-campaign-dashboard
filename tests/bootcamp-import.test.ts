// Bootcamp import (Phase 2A) — config defaults + anchors, URL paste parsing,
// candidate classification (manual assignment is the source of truth: existing
// assignments never overwritten, removed never re-added, overlap → review), and
// a DRY-RUN integration (real JsonStore + injected fake provider) proving it
// resolves anchors, auto-enumerates YouTube from the start date, estimates
// credits, and NEVER writes a video.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOTCAMP_DEFAULTS,
  classifyCandidate,
  extractUrls,
  getBootcampImportDefaults,
  parseImportConfig,
  runBootcampDryRun,
  type BootcampProviderAdapter,
} from "@/lib/bootcamp-import";
import { eligibilityFloorForCampaign, etMidnightMs } from "@/lib/eligibility";
import { campaignTag, videoCampaign } from "@/lib/campaigns";
import { parseVideoUrl } from "@/lib/url-parse";
import { readFileSync } from "fs";
import path from "path";
import type { NormalizedVideo, Platform } from "@/lib/types";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

const BOOTCAMP_START = etMidnightMs("2026-04-11");
const MTL_START = etMidnightMs("2026-06-08");

// ── Defaults + config ────────────────────────────────────────────────────────
describe("Bootcamp defaults + config", () => {
  it("start date 2026-04-11 + a first-video anchor per platform", () => {
    expect(BOOTCAMP_DEFAULTS.startDate).toBe("2026-04-11");
    expect(BOOTCAMP_DEFAULTS.anchors.tiktok).toContain("tiktok.com/@cybernick0x/video/7627682544586083614");
    expect(BOOTCAMP_DEFAULTS.anchors.youtube).toContain("youtube.com/shorts/uAH54si-VJ8");
    expect(BOOTCAMP_DEFAULTS.anchors.facebook).toContain("facebook.com/reel/826026589994871");
    expect(BOOTCAMP_DEFAULTS.anchors.instagram).toContain("instagram.com/reel/DXA4QZtDKMC");
  });
  it("getBootcampImportDefaults pre-fills start date + anchor for each platform", () => {
    const restore = stashEnv(["BOOTCAMP_START_DATE", "BOOTCAMP_ANCHOR_TIKTOK"]);
    const d = getBootcampImportDefaults();
    for (const p of ["tiktok", "instagram", "facebook", "youtube"] as Platform[]) {
      expect(d.platforms[p].startDate).toBe("2026-04-11");
      expect(d.platforms[p].anchorUrl).toBeTruthy();
    }
    restore();
  });
  it("env overrides the start date + a platform anchor", () => {
    const restore = stashEnv(["BOOTCAMP_START_DATE", "BOOTCAMP_ANCHOR_TIKTOK"]);
    process.env.BOOTCAMP_START_DATE = "2026-04-15";
    process.env.BOOTCAMP_ANCHOR_TIKTOK = "https://www.tiktok.com/@cybernick0x/video/999";
    const d = getBootcampImportDefaults();
    expect(d.startDate).toBe("2026-04-15");
    expect(d.platforms.tiktok.anchorUrl).toContain("/video/999");
    restore();
  });
});

describe("extractUrls", () => {
  it("parses newline/CSV/space lists, dedupes, drops non-http", () => {
    const text = "https://a.com/1\nhttps://a.com/2, https://a.com/1\nnot-a-url  https://a.com/3";
    expect(extractUrls(text)).toEqual(["https://a.com/1", "https://a.com/2", "https://a.com/3"]);
  });
  it("empty / non-string → []", () => {
    expect(extractUrls("")).toEqual([]);
    expect(extractUrls(undefined)).toEqual([]);
  });
});

describe("parseImportConfig", () => {
  it("validates dates, parses pasted URLs, falls back to defaults", () => {
    const cfg = parseImportConfig({
      startDate: "2026-04-11",
      platforms: {
        tiktok: { startDate: "bad-date", anchorUrl: "  ", pastedUrls: "https://www.tiktok.com/@x/video/1\nhttps://www.tiktok.com/@x/video/2", maxCandidates: "5" },
      },
    });
    expect(cfg.startDate).toBe("2026-04-11");
    expect(cfg.platforms.tiktok.startDate).toBe("2026-04-11"); // invalid → top default
    expect(cfg.platforms.tiktok.anchorUrl).toBeNull(); // blank → null
    expect(cfg.platforms.tiktok.pastedUrls).toHaveLength(2);
    expect(cfg.platforms.tiktok.maxCandidates).toBe(5);
  });
});

// ── Classification (pure) ────────────────────────────────────────────────────
describe("classifyCandidate — manual assignment is the source of truth", () => {
  const parsed = parseVideoUrl("https://www.tiktok.com/@cybernick0x/video/7627682544586083614");
  const cls = (over: Partial<Parameters<typeof classifyCandidate>[0]>) =>
    classifyCandidate({
      parsed,
      publishedAt: "2026-04-12T00:00:00.000Z",
      existing: null,
      bootcampStartMs: BOOTCAMP_START,
      mtlStartMs: MTL_START,
      source: "anchor",
      ...over,
    }).classification;

  it("pre-MTL date → suggested_bootcamp", () => {
    expect(cls({ publishedAt: "2026-04-12T00:00:00.000Z" })).toBe("suggested_bootcamp");
  });
  it("date within the MTL window → overlap (manual review)", () => {
    expect(cls({ publishedAt: "2026-06-20T00:00:00.000Z" })).toBe("overlap");
  });
  it("before the Bootcamp start → before_start (skipped, never scraped earlier)", () => {
    expect(cls({ publishedAt: "2026-03-01T00:00:00.000Z" })).toBe("before_start");
  });
  it("missing/invalid date with a known date source → invalid_date", () => {
    expect(cls({ publishedAt: "1970-01-01T00:00:00.000Z" })).toBe("invalid_date");
  });
  it("unresolved pasted URL (no date) → suggested_bootcamp_unresolved", () => {
    expect(cls({ publishedAt: null, source: "pasted" })).toBe("suggested_bootcamp_unresolved");
  });
  it("invalid URL → invalid_url", () => {
    expect(cls({ parsed: null })).toBe("invalid_url");
  });
  it("EXISTING MTL is never overwritten → already_mtl", () => {
    expect(cls({ existing: { videoId: "v1", campaign: "mtl", excluded: false } })).toBe("already_mtl");
  });
  it("EXISTING Bootcamp → already_bootcamp (duplicate)", () => {
    expect(cls({ existing: { videoId: "v1", campaign: "bootcamp", excluded: false } })).toBe("already_bootcamp");
  });
  it("EXCLUDED/removed is never re-added → already_excluded (even if tagged)", () => {
    expect(cls({ existing: { videoId: "v1", campaign: "mtl", excluded: true } })).toBe("already_excluded");
  });
});

// ── Phase 2A review fixes: campaign-aware restore floor + dry-run credit log ──
describe("campaignTag — restore-floor reads the tag even when excluded", () => {
  const raw = (r: unknown) => ({ rawJson: r as never });
  it("an EXCLUDED Bootcamp record still reports bootcamp (videoCampaign would say null)", () => {
    const v = raw({ campaign: "bootcamp", tracking: { status: "excluded", reason: "x" } });
    expect(videoCampaign(v)).toBeNull(); // exclusion dominates for scoping
    expect(campaignTag(v)).toBe("bootcamp"); // but the tag is preserved for the floor
    expect(eligibilityFloorForCampaign(campaignTag(v))).toBe(etMidnightMs("2026-04-11"));
  });
  it("untagged / MTL / unassigned use the MTL floor", () => {
    expect(eligibilityFloorForCampaign(campaignTag(raw(null)))).toBe(etMidnightMs("2026-06-08"));
    expect(eligibilityFloorForCampaign(campaignTag(raw({ campaign: "mtl" })))).toBe(etMidnightMs("2026-06-08"));
    expect(eligibilityFloorForCampaign(campaignTag(raw({ campaign: "unassigned" })))).toBe(etMidnightMs("2026-06-08"));
  });
  it("the manual-add route uses the campaign-aware floor (not the flat MTL floor)", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/api/admin/videos/route.ts"), "utf-8");
    expect(src).toMatch(/eligibilityFloorForCampaign\(campaignTag\(existing\)\)/);
    expect(src).not.toMatch(/const startMs = campaignStartMs\(\)/);
  });
});

describe("dry-run route logs anchor-resolution credits (so the cap can't be understated)", () => {
  it("records a SocialCrawl CollectionAttempt for anchor getVideoMetadata calls", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/api/admin/bootcamp-import/dry-run/route.ts"), "utf-8");
    expect(src).toMatch(/addCollectionAttempt/);
    expect(src).toMatch(/isSocialcrawlPlatform\(platform\)/);
    expect(src).toMatch(/dry-run anchor · 1cr/);
  });
});

// ── Dry-run integration ──────────────────────────────────────────────────────
const nv = (over: Partial<NormalizedVideo>): NormalizedVideo => ({
  platform: "tiktok",
  originalUrl: "https://example.com/x",
  externalVideoId: null,
  title: null,
  caption: null,
  thumbnailUrl: null,
  publishedAt: null,
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

describe("runBootcampDryRun — read-only, no writes", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    process.env.CAMPAIGN_START_DATE_ET = "2026-06-08";
  });
  afterEach(async () => {
    reset();
    delete process.env.CAMPAIGN_START_DATE_ET;
    await tmp.cleanup();
  });

  const TT_ANCHOR = "https://www.tiktok.com/@cybernick0x/video/7627682544586083614";
  const TT_EXISTING_MTL = "https://www.tiktok.com/@cybernick0x/video/111";
  const TT_EXISTING_EXCLUDED = "https://www.tiktok.com/@cybernick0x/video/222";
  const TT_NEW = "https://www.tiktok.com/@cybernick0x/video/333";
  const YT_ANCHOR = "https://www.youtube.com/shorts/uAH54si-VJ8";

  it("resolves anchors, enumerates YouTube from the start date, estimates credits, writes nothing", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);

    const insert = (over: Record<string, unknown>) =>
      store.insertVideo({
        campaignId: campaign.id,
        platform: "tiktok",
        profileId: null,
        title: "x",
        caption: null,
        thumbnailUrl: null,
        publishedAt: "2026-04-20T00:00:00.000Z",
        firstTrackedAt: "2026-04-20T00:00:00.000Z",
        lastRefreshedAt: null,
        status: "active",
        episodeGroupId: null,
        sourceStatus: "live",
        errorMessage: null,
        isSeed: false,
        ...over,
      } as Parameters<typeof store.insertVideo>[0]);

    await insert({ originalUrl: TT_EXISTING_MTL, externalVideoId: "111", hidden: false, rawJson: { campaign: "mtl" } });
    await insert({ originalUrl: TT_EXISTING_EXCLUDED, externalVideoId: "222", hidden: true, rawJson: { tracking: { status: "excluded", reason: "off" } } });

    const countBefore = (await store.listVideos({ includeHidden: true })).length;

    // Count anchor resolutions to prove we do NOT scrape the whole profile or
    // resolve every pasted URL during the dry run.
    let ttResolveCalls = 0;
    let ytEnumCalls = 0;
    const providers: Record<Platform, BootcampProviderAdapter | null> = {
      tiktok: {
        getVideoMetadata: async (url) => {
          ttResolveCalls++;
          return url === TT_ANCHOR
            ? nv({ platform: "tiktok", originalUrl: TT_ANCHOR, externalVideoId: "7627682544586083614", publishedAt: "2026-04-12T00:00:00.000Z", views: 23144 })
            : null;
        },
      },
      instagram: null, // not connected
      facebook: null,
      youtube: {
        getVideoMetadata: async (url) =>
          url === YT_ANCHOR ? nv({ platform: "youtube", originalUrl: YT_ANCHOR, externalVideoId: "uAH54si-VJ8", publishedAt: "2026-04-12T00:00:00.000Z" }) : null,
        listRecentUploads: async (since) => {
          ytEnumCalls++;
          // Provider would filter by `since`; return one before-start to prove
          // the classifier also guards it.
          void since;
          return [
            nv({ platform: "youtube", originalUrl: "https://www.youtube.com/shorts/aaaaaaaaaaa", externalVideoId: "aaaaaaaaaaa", publishedAt: "2026-05-01T00:00:00.000Z" }),
            nv({ platform: "youtube", originalUrl: "https://www.youtube.com/shorts/bbbbbbbbbbb", externalVideoId: "bbbbbbbbbbb", publishedAt: "2026-06-20T00:00:00.000Z" }), // overlap
            nv({ platform: "youtube", originalUrl: "https://www.youtube.com/shorts/ccccccccccc", externalVideoId: "ccccccccccc", publishedAt: "2026-03-01T00:00:00.000Z" }), // before start
          ];
        },
      },
    };

    const config = parseImportConfig({
      startDate: "2026-04-11",
      platforms: {
        tiktok: { anchorUrl: TT_ANCHOR, pastedUrls: [TT_EXISTING_MTL, TT_EXISTING_EXCLUDED, TT_NEW].join("\n") },
        youtube: { anchorUrl: YT_ANCHOR },
        instagram: { anchorUrl: "" }, // isolate the credit estimate to TT + YT
        facebook: { anchorUrl: "" },
      },
    });

    const report = await runBootcampDryRun(store, config, {
      now: new Date("2026-06-25T12:00:00.000Z"),
      getProvider: async (p) => providers[p],
      attempts: [],
    });

    // NOTHING written.
    expect((await store.listVideos({ includeHidden: true })).length).toBe(countBefore);

    // Anchor resolved once (NOT the whole profile, NOT every pasted URL).
    expect(ttResolveCalls).toBe(1);
    expect(ytEnumCalls).toBe(1);

    const tt = report.platforms.find((p) => p.platform === "tiktok")!;
    expect(tt.anchorResolved).toBe(true);
    expect(tt.anchorIncludedAsCandidate).toBe(true);
    expect(tt.byClass.suggested_bootcamp).toBe(1); // the anchor (2026-04-12)
    expect(tt.byClass.already_mtl).toBe(1); // existing MTL not overwritten
    expect(tt.byClass.already_excluded).toBe(1); // removed not re-added
    expect(tt.byClass.suggested_bootcamp_unresolved).toBe(1); // the new pasted URL

    const yt = report.platforms.find((p) => p.platform === "youtube")!;
    expect(yt.byClass.suggested_bootcamp).toBeGreaterThanOrEqual(2); // anchor + 2026-05-01
    expect(yt.byClass.overlap).toBe(1); // 2026-06-20 in the MTL window
    expect(yt.byClass.before_start).toBe(1); // 2026-03-01 dropped

    // Credit estimate: TT anchor + new pasted = 2 importable SC candidates (1cr each);
    // YouTube is free quota (no SC credit).
    expect(tt.estSocialcrawlCredits).toBe(2);
    expect(report.totals.estSocialcrawlCredits).toBe(2);
    expect(report.totals.candidatesFound).toBeGreaterThan(0);
    expect(report.fitsUnderTodayCap).toBe(true);
  });
});
