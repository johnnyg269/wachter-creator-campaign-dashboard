// Facebook thumbnail repair reliability + persistence:
//  - verifyFacebook pass server-probes stored fbcdn covers and re-resolves ONLY
//    the dead ones (present URL, frozen "valid") via the detail endpoint;
//  - a live cover is never touched, never overwritten, never re-spent;
//  - a provider echoing the SAME expired URL is not miscounted as repaired;
//  - excluded / removed videos are never probed or repaired;
//  - healExistingVideo routes the thumbnail through nextThumbnailState +
//    mergeThumbIntoRaw so a heal can't wipe a good cover or drop thumb state.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedVideo, Video } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

type Feed = { videos: NormalizedVideo[]; commentsByVideo: Record<string, unknown>; attempts: unknown[] };

// Controllable provider + probe fixtures (hoisted so the vi.mock factory sees them).
const ctrl = vi.hoisted(() => ({
  detail: new Map<string, NormalizedVideo | null>(), // originalUrl → getVideoMetadata result
  live: new Set<string>(), // URLs the mocked proxy-fetch treats as a live image
  feed: {} as Record<string, (() => Promise<Feed>) | undefined>, // per-platform fetchPlatform
}));

vi.mock("@/lib/providers/registry", () => {
  const empty: Feed = { videos: [], commentsByVideo: {}, attempts: [] };
  const mk = (platform: string) => ({
    providerType: "socialcrawl" as const,
    supportsComments: false,
    supportsDiscovery: true,
    getVideoMetadata: async (url: string) => ctrl.detail.get(url) ?? null,
    fetchPlatform: async () => (ctrl.feed[platform] ? ctrl.feed[platform]!() : empty),
  });
  const ready = (p: string) => ({
    provider: mk(p),
    readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
    config: null,
  });
  return {
    resolveProvider: async (p: string) => ready(p),
    resolveAllProviders: async () => ({
      tiktok: ready("tiktok"),
      youtube: ready("youtube"),
      instagram: ready("instagram"),
      facebook: ready("facebook"),
    }),
  };
});

import { repairMissingThumbnails } from "@/lib/thumbnail-repair";
import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { readThumbState } from "@/lib/thumbnail-state";
import { useTmpCwd, type TmpCwd } from "./helpers";

const FB = (name: string) => `https://www.facebook.com/reel/${name}`;
const cover = (tag: string) => `https://scontent.xx.fbcdn.net/v/${tag}.jpg`;

const nv = (over: Partial<NormalizedVideo> = {}): NormalizedVideo => ({
  platform: "facebook",
  originalUrl: FB("x"),
  externalVideoId: "x",
  title: "v",
  caption: null,
  thumbnailUrl: null,
  publishedAt: "2026-07-01T00:00:00.000Z",
  authorName: null,
  authorHandle: null,
  views: 1000,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  bookmarks: null,
  rawJson: { source: "socialcrawl" },
  ...over,
});

async function insertFb(
  campaignId: string,
  over: Partial<Video> & { thumbStatus?: string } = {},
): Promise<Video> {
  const { thumbStatus, ...rest } = over;
  const store = getStore();
  const raw: Record<string, unknown> = { source: "socialcrawl", campaign: "bootcamp" };
  if (thumbStatus) {
    raw.thumb = {
      status: thumbStatus,
      attempts: 0,
      lastAttemptAt: "2026-07-01T00:00:00.000Z",
      nextRetryAt: null,
      failureReason: null,
      resolvedFrom: "provider",
    };
  }
  return store.insertVideo({
    campaignId,
    platform: "facebook",
    profileId: null,
    originalUrl: FB("default"),
    externalVideoId: "default",
    title: "t",
    caption: null,
    thumbnailUrl: null,
    publishedAt: "2026-07-01T00:00:00.000Z",
    firstTrackedAt: "2026-07-01T00:00:00.000Z",
    lastRefreshedAt: "2026-07-01T00:00:00.000Z",
    status: "active",
    episodeGroupId: null,
    sourceStatus: "live",
    errorMessage: null,
    hidden: false,
    isSeed: false,
    rawJson: raw as Video["rawJson"],
    ...rest,
  } as Parameters<typeof store.insertVideo>[0]);
}

const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);

// The repair suite reads the store DIRECTLY (no loadCampaignData), so it needs no
// seeded campaign — a constant id keeps the candidate set to exactly the videos
// each test inserts (ensureSeedData would add 4 null-thumbnail seed videos that
// pollute the aggregate repaired/probed counts).
const CID = "campaign-1";

describe("repairMissingThumbnails — verifyFacebook cover recovery", () => {
  let tmp: TmpCwd;
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    ctrl.detail.clear();
    ctrl.live.clear();
    ctrl.feed = {};
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01";
    // Mocked proxy fetch: 200 image/* for URLs in ctrl.live, 404 otherwise.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = typeof input === "string" ? input : String(input);
        const live = ctrl.live.has(url);
        return new Response(live ? new Uint8Array([1, 2, 3]) : null, {
          status: live ? 200 : 404,
          headers: { "content-type": live ? "image/jpeg" : "application/json" },
        });
      }),
    );
  });
  afterEach(async () => {
    reset();
    vi.unstubAllGlobals();
    delete process.env.CAMPAIGN_START_DATE_ET;
    await tmp.cleanup();
  });

  it("leaves a LIVE fbcdn cover untouched — never re-resolves, never overwrites, never spends", async () => {
    const store = getStore();
    const good = cover("live-good");
    ctrl.live.add(good);
    const v = await insertFb(CID, {
      originalUrl: FB("LIVE"),
      externalVideoId: "LIVE",
      thumbnailUrl: good,
      thumbStatus: "valid",
    });
    // A detail result exists but must NOT be used (cover is live).
    ctrl.detail.set(FB("LIVE"), nv({ originalUrl: FB("LIVE"), thumbnailUrl: cover("should-not-be-used") }));

    const res = await repairMissingThumbnails(store, { force: true, verifyFacebook: true });

    expect(res.facebookCoversProbed).toBe(1);
    expect(res.facebookDeadCovers).toBe(0);
    expect(res.repaired).toBe(0);
    const after = await store.getVideo(v.id);
    expect(after!.thumbnailUrl).toBe(good); // unchanged
    const attempts = await store.listCollectionAttempts(50);
    expect(attempts.length).toBe(0); // no detail call → no credit spent
  });

  it("re-resolves a DEAD fbcdn cover to a new live cover and counts it repaired", async () => {
    const store = getStore();
    const dead = cover("expired");
    const fresh = cover("fresh-live");
    ctrl.live.add(fresh); // dead is NOT live
    const v = await insertFb(CID, {
      originalUrl: FB("DEAD"),
      externalVideoId: "DEAD",
      thumbnailUrl: dead,
      thumbStatus: "valid",
    });
    ctrl.detail.set(FB("DEAD"), nv({ originalUrl: FB("DEAD"), thumbnailUrl: fresh }));

    const res = await repairMissingThumbnails(store, { force: true, verifyFacebook: true });

    expect(res.facebookDeadCovers).toBe(1);
    expect(res.repaired).toBe(1);
    const after = await store.getVideo(v.id);
    expect(after!.thumbnailUrl).toBe(fresh);
    expect(readThumbState(after!.rawJson).status).toBe("valid");
  });

  it("does NOT miscount a provider that echoes the SAME expired URL as repaired", async () => {
    const store = getStore();
    const dead = cover("still-expired"); // stays out of ctrl.live
    const v = await insertFb(CID, {
      originalUrl: FB("ECHO"),
      externalVideoId: "ECHO",
      thumbnailUrl: dead,
      thumbStatus: "valid",
    });
    ctrl.detail.set(FB("ECHO"), nv({ originalUrl: FB("ECHO"), thumbnailUrl: dead }));

    const res = await repairMissingThumbnails(store, { force: true, verifyFacebook: true });

    expect(res.facebookDeadCovers).toBe(1);
    expect(res.repaired).toBe(0);
    expect(res.stillMissing).toBe(1);
    const after = await store.getVideo(v.id);
    expect(after!.thumbnailUrl).toBe(dead); // last-known URL preserved, not wiped
  });

  it("never probes or repairs an excluded / removed video", async () => {
    const store = getStore();
    const dead = cover("excluded-dead");
    const v = await insertFb(CID, {
      originalUrl: FB("EXCL"),
      externalVideoId: "EXCL",
      thumbnailUrl: dead,
      thumbStatus: "valid",
      hidden: true,
      rawJson: {
        source: "socialcrawl",
        campaign: "bootcamp",
        tracking: { status: "excluded", excludedAt: "2026-07-02T00:00:00.000Z", reason: "test" },
      } as Video["rawJson"],
    });
    ctrl.detail.set(FB("EXCL"), nv({ originalUrl: FB("EXCL"), thumbnailUrl: cover("fresh") }));

    const res = await repairMissingThumbnails(store, { force: true, verifyFacebook: true });

    expect(res.facebookCoversProbed).toBe(0); // excluded never enters the probe set
    expect(res.repaired).toBe(0);
    const after = await store.getVideo(v.id);
    expect(after!.thumbnailUrl).toBe(dead); // untouched
  });

  it("recovers a no-URL back-catalog cover (force retries a 'failed' state)", async () => {
    const store = getStore();
    const fresh = cover("recovered");
    ctrl.live.add(fresh);
    const v = await insertFb(CID, {
      originalUrl: FB("NOURL"),
      externalVideoId: "NOURL",
      thumbnailUrl: null,
      thumbStatus: "failed", // gave up during the profile-retry loop
    });
    ctrl.detail.set(FB("NOURL"), nv({ originalUrl: FB("NOURL"), thumbnailUrl: fresh }));

    // Without force, a "failed" cover is skipped (no re-spend)…
    const skipped = await repairMissingThumbnails(store, { verifyFacebook: false });
    expect(skipped.repaired).toBe(0);
    // …with force, the detail endpoint recovers it.
    const res = await repairMissingThumbnails(store, { force: true, verifyFacebook: false });
    expect(res.repaired).toBe(1);
    expect((await store.getVideo(v.id))!.thumbnailUrl).toBe(fresh);
  });
});

describe("healExistingVideo — thumbnail persistence (Cause C)", () => {
  let tmp: TmpCwd;
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    ctrl.detail.clear();
    ctrl.feed = {};
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01";
    delete process.env.ADMIN_PASSWORD;
  });
  afterEach(async () => {
    reset();
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
    delete process.env.CAMPAIGN_START_DATE_ET;
    await tmp.cleanup();
  });

  it("keeps a good cover when a heal's provider payload has NO thumbnail", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const good = cover("kept-good");
    // A 1970-date record → excluded → heal path; it already has a good cover.
    const v = await insertFb(campaign.id, {
      originalUrl: FB("HEAL"),
      externalVideoId: "HEAL",
      thumbnailUrl: good,
      thumbStatus: "valid",
      publishedAt: "1970-01-21T00:00:00.000Z",
    });
    // Provider heals the date (valid recent) but returns NO cover this pass.
    ctrl.feed.facebook = async () => ({
      videos: [
        nv({
          originalUrl: FB("HEAL"),
          externalVideoId: "HEAL",
          thumbnailUrl: null,
          publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
          views: 4242,
        }),
      ],
      commentsByVideo: {},
      attempts: [],
    });

    await runRefresh("script");

    const after = await store.getVideo(v.id);
    expect(after!.thumbnailUrl).toBe(good); // good cover NOT wiped to null
    expect(after!.hidden).toBe(false); // healed
    expect(readThumbState(after!.rawJson).status).toBe("valid"); // thumb state preserved
  });
});

describe("safety — repair leaks no secrets / internals", () => {
  it("thumbnail-repair exposes no tokens or hardcoded secrets", () => {
    const src = read("src/lib/thumbnail-repair.ts");
    expect(src).not.toMatch(/sc_[A-Za-z0-9]{20,}/); // no SocialCrawl token
    expect(src).not.toMatch(/x-api-key|apify_api_[A-Za-z0-9]/i);
  });
  it("repair never enables Apify (resolveProvider called with apifyAllowed=false)", () => {
    expect(read("src/lib/thumbnail-repair.ts")).toContain("resolveProvider(p, store, false)");
  });
});
