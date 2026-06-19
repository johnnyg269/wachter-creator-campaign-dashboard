// Stability pass (2026-06-18): Facebook chart drop, missing-from-provider
// preservation, Facebook thumbnail repair (SocialCrawl detail, never Apify),
// and refresh-delay thresholds. The headline fix is aggregateTrend carrying
// forward last-known-good PER FIELD so a monotonic-rejected (views:null)
// snapshot or a missing cycle never creates an artificial drop.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateTrend,
  applyMonotonicViews,
  computeVideoMetrics,
  type TrendPoint,
} from "@/lib/metrics";
import {
  nextThumbnailState,
  readThumbState,
  MAX_THUMBNAIL_RETRIES,
  type ThumbnailState,
} from "@/lib/thumbnail-state";
import { makeSnapshot, makeVideo } from "./helpers";
import type { MetricSnapshot } from "@/lib/types";

const lastWithData = (pts: TrendPoint[]) => [...pts].reverse().find((p) => p.views !== null) ?? null;

// ── FB chart drop — the core fix (unit, deterministic) ─────────────────────────
describe("aggregateTrend carries forward last-known-good (no artificial drop)", () => {
  const map = (snapsByVideo: Record<string, MetricSnapshot[]>) =>
    new Map(Object.entries(snapsByVideo));
  const from = new Date("2026-06-18T11:00:00.000Z");
  const to = new Date("2026-06-18T14:00:00.000Z");

  it("a later views:null snapshot (monotonic rejection) does NOT drop the line", () => {
    const snaps = [
      makeSnapshot({ videoId: "fb1", capturedAt: "2026-06-18T12:00:00.000Z", views: 100000 }),
      // Monotonic rejected a lower rounded SocialCrawl reading → stored null.
      makeSnapshot({ videoId: "fb1", capturedAt: "2026-06-18T13:00:00.000Z", views: null, comments: 10 }),
    ];
    const pts = aggregateTrend(map({ fb1: snaps }), from, to, 3);
    // Every bucket from 12:00 on carries 100000 — including the last one.
    expect(pts[pts.length - 1].views).toBe(100000);
    expect(pts.filter((p) => p.views !== null).every((p) => p.views === 100000)).toBe(true);
  });

  it("the final bucket equals the SUM of each video's last-confirmed views (platform total)", () => {
    const a = [
      makeSnapshot({ videoId: "a", capturedAt: "2026-06-18T12:00:00.000Z", views: 100000 }),
      makeSnapshot({ videoId: "a", capturedAt: "2026-06-18T13:00:00.000Z", views: null }),
    ];
    const b = [makeSnapshot({ videoId: "b", capturedAt: "2026-06-18T12:30:00.000Z", views: 5000 })];
    const pts = aggregateTrend(map({ a, b }), from, to, 3);
    expect(lastWithData(pts)?.views).toBe(105000);
    // Same basis as the KPI/platform total (confirmed.views):
    const now = new Date("2026-06-18T14:00:00.000Z");
    const confA = computeVideoMetrics(makeVideo({ id: "a" }), a, now).confirmed.views?.value ?? 0;
    const confB = computeVideoMetrics(makeVideo({ id: "b" }), b, now).confirmed.views?.value ?? 0;
    expect(confA + confB).toBe(105000);
  });

  it("a video missing from a later cycle carries forward (not dropped to a gap)", () => {
    const a = [
      makeSnapshot({ videoId: "a", capturedAt: "2026-06-18T12:00:00.000Z", views: 1000 }),
      makeSnapshot({ videoId: "a", capturedAt: "2026-06-18T13:00:00.000Z", views: 1100 }),
    ];
    // b only appears in the 12:00 cycle (absent from the 13:00 profile response).
    const b = [makeSnapshot({ videoId: "b", capturedAt: "2026-06-18T12:00:00.000Z", views: 500 })];
    const pts = aggregateTrend(map({ a, b }), from, to, 3);
    expect(lastWithData(pts)?.views).toBe(1600); // 1100 + carried-forward 500
  });

  it("a never-confirmed video yields a gap (null), never a fake zero", () => {
    const only = [makeSnapshot({ videoId: "x", capturedAt: "2026-06-18T12:00:00.000Z", views: null })];
    const pts = aggregateTrend(map({ x: only }), from, to, 3);
    expect(pts.every((p) => p.views === null)).toBe(true);
  });

  it("comments/engagements also carry forward per field independently", () => {
    const snaps = [
      makeSnapshot({ videoId: "v", capturedAt: "2026-06-18T12:00:00.000Z", views: 10, comments: 4, likes: 2 }),
      // views rejected (null) but comments still reported this cycle
      makeSnapshot({ videoId: "v", capturedAt: "2026-06-18T13:00:00.000Z", views: null, comments: 7, likes: 3 }),
    ];
    const last = lastWithData(aggregateTrend(map({ v: snaps }), from, to, 3));
    expect(last?.views).toBe(10); // carried
    expect(last?.comments).toBe(7); // fresh
  });

  it("engagement COMPONENTS carry forward independently (likes then comments → sum, not collapse)", () => {
    // The bug this guards: engagements is a composite; a cycle reporting only
    // comments must not drop the previously confirmed likes. FB Reels report
    // likes/comments on different tiers, so this is a real production shape.
    const snaps = [
      makeSnapshot({ videoId: "v", capturedAt: "2026-06-18T12:00:00.000Z", likes: 100, comments: null, views: null }),
      makeSnapshot({ videoId: "v", capturedAt: "2026-06-18T13:00:00.000Z", likes: null, comments: 5, views: null }),
    ];
    const last = [...aggregateTrend(map({ v: snaps }), from, to, 3)].reverse().find((p) => p.engagements !== null);
    expect(last?.engagements).toBe(105); // 100 likes (carried) + 5 comments, NOT 5
  });
});

// ── Monotonic protection (per-video write rule) ────────────────────────────────
describe("Facebook monotonic protection feeds the carry-forward", () => {
  it("a lower reading is rejected (stored as null) so the chart keeps the higher value", () => {
    expect(applyMonotonicViews(99000, 100000)).toEqual({ views: null, rejectedLower: 99000 });
    expect(applyMonotonicViews(101000, 100000)).toEqual({ views: 101000, rejectedLower: null });
  });
});

// ── FB thumbnail repair semantics (unit) ───────────────────────────────────────
describe("Facebook thumbnail repair / preservation", () => {
  const fresh = () => ({
    status: "missing" as const, attempts: 0, lastAttemptAt: null, nextRetryAt: null,
    failureReason: null, resolvedFrom: null,
  });
  const now = "2026-06-18T12:00:00.000Z";
  const FBCDN = "https://scontent.xx.fbcdn.net/cover.jpg";

  it("a recovered FB cover (server-verifiable) is stored as valid", () => {
    const r = nextThumbnailState({ resolvedUrl: FBCDN, existingUrl: null, prev: fresh(), isDiscovery: true, now, verifiable: true });
    expect(r.thumbnailUrl).toBe(FBCDN);
    expect(r.thumb.status).toBe("valid");
  });

  it("a missing FB thumbnail preserves last-known-good and is never overwritten with a placeholder", () => {
    const prev = { ...fresh(), status: "valid" as const, resolvedFrom: "provider" };
    const r = nextThumbnailState({ resolvedUrl: null, existingUrl: FBCDN, prev, isDiscovery: true, now });
    expect(r.thumbnailUrl).toBe(FBCDN); // kept
  });

  it("repair does not retry forever — caps at MAX then 'failed'", () => {
    let prev: ThumbnailState = fresh();
    for (let i = 0; i < MAX_THUMBNAIL_RETRIES; i++) {
      prev = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev, isDiscovery: true, now }).thumb;
    }
    expect(prev.status).toBe("failed");
    // A failed FB video is excluded from the repair batch (status !== "failed" filter).
    expect(readThumbState({ thumb: prev }).status).toBe("failed");
  });
});

// ── End-to-end: monotonic null snapshot → chart still carries forward ───────────
const ctrl = vi.hoisted(() => ({ fb: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/providers/registry", () => {
  const mk = (platform: string) => ({
    provider: {
      providerType: "socialcrawl" as const,
      supportsComments: false,
      supportsDiscovery: true,
      fetchPlatform: async () =>
        platform === "facebook" && ctrl.fb ? ctrl.fb() : { videos: [], commentsByVideo: {}, attempts: [] },
      getVideoMetadata: async () => null,
      getVideoMetrics: async () => null,
      getVideoComments: async () => [],
      discoverNewVideos: async () => [],
    },
    readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
    config: null,
  });
  return {
    resolveProvider: async (p: string) => mk(p),
    resolveAllProviders: async () => ({ tiktok: mk("tiktok"), youtube: mk("youtube"), instagram: mk("instagram"), facebook: mk("facebook") }),
  };
});

import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, type TmpCwd } from "./helpers";

describe("FB lower value → null snapshot → aggregate still carries forward (integration)", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => { tmp = await useTmpCwd(); reset(); ctrl.fb = null; process.env.CAMPAIGN_START_DATE_ET = "2026-06-08"; });
  afterEach(async () => {
    reset(); ctrl.fb = null; delete process.env.CAMPAIGN_START_DATE_ET;
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
    await tmp.cleanup();
  });

  it("a rejected lower Facebook reading does not lower the platform total or the chart's last point", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const fbVideo = await store.insertVideo({
      campaignId: campaign.id, platform: "facebook", profileId: null,
      originalUrl: "https://www.facebook.com/reel/1361860342502757", externalVideoId: "1361860342502757",
      title: "FB reel", caption: null, thumbnailUrl: "https://scontent.xx.fbcdn.net/good.jpg",
      publishedAt: "2026-06-10T00:00:00.000Z", firstTrackedAt: "2026-06-10T00:00:00.000Z",
      lastRefreshedAt: "2026-06-12T00:00:00.000Z", status: "active", episodeGroupId: null,
      sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false, rawJson: null,
    });
    // Seed a confirmed high reading (public plays).
    await store.addSnapshot({ videoId: fbVideo.id, capturedAt: "2026-06-18T12:00:00.000Z", views: 136000, likes: null, comments: null, shares: null, saves: null, bookmarks: null, engagementRate: null, rawJson: null });

    // SocialCrawl returns a LOWER rounded reading this cycle (135000 < 136000).
    ctrl.fb = async () => ({
      videos: [{
        platform: "facebook", originalUrl: "https://www.facebook.com/reel/1361860342502757", externalVideoId: "1361860342502757",
        title: "FB reel", caption: null, thumbnailUrl: null, publishedAt: "2026-06-10T00:00:00.000Z",
        authorName: null, authorHandle: null, views: 135000, likes: null, comments: null, shares: null, saves: null, bookmarks: null,
        rawJson: { source: "socialcrawl" },
      }],
      commentsByVideo: {}, attempts: [],
    });

    await runRefresh("script");

    const snaps = await store.listSnapshots(fbVideo.id);
    // The lower reading was rejected → stored as null (preserves last-known-good).
    const latest = [...snaps].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))[snaps.length - 1];
    expect(latest.views).toBeNull();

    // Per-video confirmed value (= the platform total basis) is still 136000.
    const now = new Date("2026-06-18T13:30:00.000Z");
    const m = computeVideoMetrics(fbVideo, snaps, now);
    expect(m.confirmed.views?.value).toBe(136000);

    // The aggregate chart's last point also carries forward 136000 — NO drop.
    const pts = aggregateTrend(
      new Map([[fbVideo.id, snaps]]),
      new Date("2026-06-18T11:30:00.000Z"),
      now,
      4,
    );
    expect(lastWithData(pts)?.views).toBe(136000);
  });
});
