// Facebook refresh resilience: the "every other refresh fails" bug.
//
// Facebook's actor alternates between a feed surface (carries views) and a
// reel-page surface (no usable records); some cycles also throw outright.
// These integration tests drive the REAL refresh pipeline (runRefresh →
// refreshPlatform) against a JsonStore, injecting a controllable fake provider
// via a mocked provider registry, and assert the last-known-good guarantees:
//
//   • an empty cycle never wipes good data (partial, not success, not failure)
//   • a thrown cycle preserves videos that have succeeded before (partial)
//   • a lower view reading never overwrites a higher confirmed value
//   • a null thumbnail never overwrites a stored thumbnail
//   • alternate surfaces dedupe into ONE snapshot, views surface kept
//   • when nothing is salvageable the failure path still fires
//   • error stubs are rejected at normalize
//   • public payloads never leak vendor names / raw collector JSON

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedVideo, ProviderConfig } from "@/lib/types";
import { makeProviderConfig, makeSnapshot, useTmpCwd, type TmpCwd } from "./helpers";

// Per-test control surface, hoisted so the vi.mock factory can close over it.
// fbConfig mirrors what resolveProvider would return in production (the store's
// persisted ProviderConfig); the catch path flags THAT object as failed.
const ctrl = vi.hoisted(() => ({
  fbFetch: null as null | (() => Promise<unknown>),
  fbConfig: null as ProviderConfig | null,
}));

// Replace provider resolution: Facebook gets a ready fake whose fetchPlatform
// we drive per test; the other three platforms resolve "not connected" so they
// skip cleanly and never interfere with Facebook assertions.
vi.mock("@/lib/providers/registry", () => {
  const fbProvider = {
    providerType: "apify" as const,
    supportsComments: false,
    supportsDiscovery: true,
    fetchPlatform: async () => {
      if (!ctrl.fbFetch) throw new Error("test did not set ctrl.fbFetch");
      return ctrl.fbFetch();
    },
  };
  const notReady = () => ({
    provider: { providerType: "manual" as const, supportsComments: false, supportsDiscovery: false },
    readiness: {
      ready: false,
      status: "actor_missing" as const,
      sourceStatus: "needs_apify_token" as const,
      detail: "test: not connected",
    },
    config: null,
  });
  const resolveProvider = async (platform: string) =>
    platform === "facebook"
      ? {
          provider: fbProvider,
          readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
          config: ctrl.fbConfig,
        }
      : notReady();
  const resolveAllProviders = async () => ({
    tiktok: await resolveProvider("tiktok"),
    youtube: await resolveProvider("youtube"),
    instagram: await resolveProvider("instagram"),
    facebook: await resolveProvider("facebook"),
  });
  return { resolveProvider, resolveAllProviders };
});

// Imported AFTER the mock so the registry seam is in place.
import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { loadCampaignData } from "@/lib/queries";
import { getStore } from "@/lib/store";
import { normalizeVideoItem } from "@/lib/apify/normalize";

const FB_URL = "https://www.facebook.com/reel/1234567890";
const FB_ID = "1234567890";

function fbNormalized(over: Partial<NormalizedVideo> = {}): NormalizedVideo {
  return {
    platform: "facebook",
    originalUrl: FB_URL,
    externalVideoId: FB_ID,
    title: "FB Reel",
    caption: null,
    thumbnailUrl: "https://scontent.fbcdn.net/fetched-thumb.jpg",
    publishedAt: "2026-06-10T00:00:00.000Z",
    authorName: null,
    authorHandle: null,
    views: 5000,
    likes: 100,
    comments: 5,
    shares: 2,
    saves: null,
    bookmarks: null,
    rawJson: { id: FB_ID },
    ...over,
  };
}

const fetchResult = (videos: NormalizedVideo[]) => ({ videos, commentsByVideo: {}, attempts: [] });

describe("Facebook refresh resilience (integration, real pipeline)", () => {
  let tmp: TmpCwd;
  const resetStore = () => {
    (globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined;
  };
  beforeEach(async () => {
    tmp = await useTmpCwd();
    resetStore();
    ctrl.fbFetch = null;
    ctrl.fbConfig = null;
  });
  afterEach(async () => {
    resetStore();
    ctrl.fbFetch = null;
    ctrl.fbConfig = null;
    await tmp.cleanup();
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
  });

  /**
   * Insert one tracked Facebook reel with full last-known-good state and
   * (optionally) a confirmed-views snapshot, plus a persisted provider config
   * so we can assert whether the success timestamp / status moved.
   */
  async function seedTrackedReel(opts: {
    lastRefreshedAt: string | null;
    thumbnailUrl: string | null;
    views: number | null;
    configSuccessAt?: string | null;
  }) {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await store.insertVideo({
      campaignId: campaign.id,
      platform: "facebook",
      profileId: null,
      originalUrl: FB_URL,
      externalVideoId: FB_ID,
      title: "FB Reel",
      caption: null,
      thumbnailUrl: opts.thumbnailUrl,
      publishedAt: "2026-06-10T00:00:00.000Z",
      firstTrackedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      lastRefreshedAt: opts.lastRefreshedAt,
      status: "active",
      episodeGroupId: null,
      sourceStatus: "live",
      errorMessage: null,
      hidden: false,
      isSeed: false,
      rawJson: null,
    });
    if (opts.views !== null) {
      await store.addSnapshot(
        makeSnapshot({
          videoId: v.id,
          capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
          views: opts.views,
          likes: 100,
          comments: 5,
        }),
      );
    }
    if (opts.configSuccessAt !== undefined) {
      await store.upsertProviderConfig(
        makeProviderConfig({
          platform: "facebook",
          status: "live",
          supportsMetrics: true,
          lastSuccessfulRefreshAt: opts.configSuccessAt,
        }),
      );
    }
    return v.id;
  }

  it("empty cycle keeps last-known-good: partial run, no wipe, no fresh success timestamp", async () => {
    const oldSuccess = "2026-06-13T10:00:00.000Z";
    const id = await seedTrackedReel({
      lastRefreshedAt: "2026-06-13T11:30:00.000Z",
      thumbnailUrl: "https://stored-thumb.jpg",
      views: 5000,
      configSuccessAt: oldSuccess,
    });
    ctrl.fbFetch = async () => fetchResult([]); // source returned nothing usable

    const report = await runRefresh("script");
    const store = getStore();
    const v = (await store.getVideo(id))!;
    const snaps = await store.listSnapshots(id);
    const cfg = await store.getProviderConfig("facebook");

    expect(report.status).toBe("partial");
    expect(report.platforms.find((p) => p.platform === "facebook")?.status).toBe("partial");
    // Data preserved, nothing clobbered.
    expect(v.thumbnailUrl).toBe("https://stored-thumb.jpg");
    expect(v.sourceStatus).toBe("live");
    expect(v.lastRefreshedAt).toBe("2026-06-13T11:30:00.000Z"); // not advanced
    expect(snaps.length).toBe(1); // no empty snapshot appended
    // Success timestamp must NOT advance on an empty cycle.
    expect(cfg?.lastSuccessfulRefreshAt).toBe(oldSuccess);
    // Audit trail records the preservation.
    const run = (await store.listRefreshRuns(1))[0];
    expect(run.rawLog?.some((l) => l.includes("preserved") && l.includes("last-known-good"))).toBe(true);
  });

  it("thrown cycle preserves videos that have succeeded before: partial, not failed", async () => {
    const id = await seedTrackedReel({
      lastRefreshedAt: "2026-06-13T11:00:00.000Z", // everGood
      thumbnailUrl: "https://stored-thumb.jpg",
      views: 5000,
      configSuccessAt: "2026-06-13T11:00:00.000Z",
    });
    ctrl.fbFetch = async () => {
      throw new Error("actor run failed: surface unavailable");
    };

    const report = await runRefresh("script");
    const store = getStore();
    const v = (await store.getVideo(id))!;
    const cfg = await store.getProviderConfig("facebook");

    expect(report.status).toBe("partial");
    expect(report.platforms.find((p) => p.platform === "facebook")?.status).toBe("partial");
    expect(v.thumbnailUrl).toBe("https://stored-thumb.jpg"); // preserved
    expect(v.sourceStatus).toBe("live"); // NOT flipped to refresh_failed
    expect(cfg?.status).toBe("live"); // provider not flagged failed
  });

  it("thrown cycle with nothing salvageable still fails honestly", async () => {
    // Only the never-refreshed seed reel exists (lastRefreshedAt null).
    const store = getStore();
    await ensureSeedData(store);
    ctrl.fbConfig = makeProviderConfig({ platform: "facebook", status: "live", supportsMetrics: true });
    await store.upsertProviderConfig(ctrl.fbConfig);
    ctrl.fbFetch = async () => {
      throw new Error("actor run failed: hard error");
    };

    const report = await runRefresh("script");
    const cfg = await store.getProviderConfig("facebook");
    const fbVideos = (await store.listVideos({ platform: "facebook", includeHidden: true }));

    expect(report.status).toBe("failed");
    expect(report.platforms.find((p) => p.platform === "facebook")?.status).toBe("failed");
    expect(cfg?.status).toBe("actor_test_failed");
    // The never-good seed reel surfaces the failure.
    expect(fbVideos.every((v) => v.sourceStatus === "refresh_failed")).toBe(true);
  });

  it("a lower view reading never overwrites a higher confirmed value", async () => {
    const id = await seedTrackedReel({
      lastRefreshedAt: "2026-06-13T11:00:00.000Z",
      thumbnailUrl: "https://stored-thumb.jpg",
      views: 5000, // confirmed high-water mark
      configSuccessAt: "2026-06-13T11:00:00.000Z",
    });
    ctrl.fbFetch = async () => fetchResult([fbNormalized({ views: 3000 })]); // stale/cached dip

    await runRefresh("script");
    const store = getStore();
    const snaps = (await store.listSnapshots(id)).sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    const latest = snaps[snaps.length - 1];
    const latestConfirmed = [...snaps].reverse().find((s) => s.views !== null);

    expect(latest.views).toBeNull(); // lower reading recorded as not-reported
    expect(latestConfirmed?.views).toBe(5000); // confirmed value still 5000
    const run = (await store.listRefreshRuns(1))[0];
    expect(run.rawLog?.some((l) => l.includes("rejected lower view count"))).toBe(true);
  });

  it("a null thumbnail never overwrites a stored thumbnail", async () => {
    const id = await seedTrackedReel({
      lastRefreshedAt: "2026-06-13T11:00:00.000Z",
      thumbnailUrl: "https://stored-thumb.jpg",
      views: 5000,
      configSuccessAt: "2026-06-13T11:00:00.000Z",
    });
    // Higher views (accepted) but the reel-page surface dropped the thumbnail.
    ctrl.fbFetch = async () => fetchResult([fbNormalized({ views: 6000, thumbnailUrl: null })]);

    await runRefresh("script");
    const store = getStore();
    const v = (await store.getVideo(id))!;
    const snaps = await store.listSnapshots(id);

    expect(v.thumbnailUrl).toBe("https://stored-thumb.jpg"); // preserved
    expect(snaps.some((s) => s.views === 6000)).toBe(true); // higher views accepted
  });

  it("alternate surfaces dedupe into ONE snapshot, keeping the views surface", async () => {
    const id = await seedTrackedReel({
      lastRefreshedAt: "2026-06-13T11:00:00.000Z",
      thumbnailUrl: null,
      views: null, // no prior snapshot — count cleanly
      configSuccessAt: "2026-06-13T11:00:00.000Z",
    });
    ctrl.fbFetch = async () =>
      fetchResult([
        // feed surface: has views, no thumbnail
        fbNormalized({ views: 7000, likes: 200, comments: 9, shares: 4, thumbnailUrl: null }),
        // reel-page surface: no views, has thumbnail
        fbNormalized({ views: null, likes: null, comments: null, shares: null, thumbnailUrl: "https://reel-thumb.jpg" }),
      ]);

    const report = await runRefresh("script");
    const store = getStore();
    const v = (await store.getVideo(id))!;
    const snaps = await store.listSnapshots(id);

    expect(report.platforms.find((p) => p.platform === "facebook")?.videosUpdated).toBe(1);
    expect(snaps.length).toBe(1); // ONE snapshot, not one per surface
    expect(snaps[0].views).toBe(7000); // feed views survived the merge
    expect(v.thumbnailUrl).toBe("https://reel-thumb.jpg"); // thumbnail filled from reel-page
  });

  it("error-stub items are rejected at normalize (never ingested)", () => {
    const stub = normalizeVideoItem(
      { url: "https://www.facebook.com/reel/999", error: "could not fetch post" },
      "facebook",
    );
    expect(stub).toBeNull();
    // A real reel with metrics still normalizes.
    const real = normalizeVideoItem(
      { url: "https://www.facebook.com/reel/999", videoViewCount: 1234 },
      "facebook",
    );
    expect(real).not.toBeNull();
    expect(real?.views).toBe(1234);
  });

  it("public payloads never leak vendor names or raw collector JSON", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    await store.insertVideo({
      campaignId: campaign.id,
      platform: "facebook",
      profileId: null,
      originalUrl: FB_URL,
      externalVideoId: FB_ID,
      title: "FB Reel",
      caption: null,
      thumbnailUrl: null,
      publishedAt: "2026-06-10T00:00:00.000Z",
      firstTrackedAt: new Date().toISOString(),
      lastRefreshedAt: null,
      status: "active",
      episodeGroupId: null,
      sourceStatus: "refresh_failed",
      errorMessage: "apify actor abc123 returned 0 items",
      hidden: false,
      isSeed: false,
      rawJson: { signedDatasetUrl: "https://api.apify.com/secret", vendorField: 1 },
    });

    const data = await loadCampaignData(true);
    const v = data.videos.find((x) => x.externalVideoId === FB_ID)!;
    expect(v.rawJson).toBeNull(); // raw collector payload stripped
    expect(v.errorMessage).not.toMatch(/apify/i); // vendor name scrubbed
    expect(v.errorMessage).toContain("collector");
  });
});
