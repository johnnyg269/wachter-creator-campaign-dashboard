// Option B refresh wiring — REAL pipeline (runRefresh) with a mocked provider
// registry. Proves on a SCHEDULED (cron) run: tier-gated snapshots (hot MTL
// refreshes, warm MTL not-yet-due is carried forward), the per-post DUE lane
// refreshes a Bootcamp video beyond the profile window and logs 1 credit,
// removed/excluded videos are never fetched / snapshotted / charged, and
// comment pulls are limited to the hot-MTL subset.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedVideo } from "@/lib/types";
import type { PlatformFetchOptions, PlatformFetchResult } from "@/lib/providers/types";

const ctrl = vi.hoisted(() => ({
  sweep: {} as Record<string, () => PlatformFetchResult>,
  detail: {} as Record<string, NormalizedVideo | null>,
  detailCalls: [] as string[],
  lastOpts: {} as Record<string, PlatformFetchOptions | undefined>,
}));

vi.mock("@/lib/providers/registry", () => {
  const make = (platform: string) => ({
    provider: {
      providerType: "socialcrawl" as const,
      supportsComments: true,
      supportsDiscovery: true,
      getVideoMetadata: async (url: string) => {
        ctrl.detailCalls.push(url);
        return ctrl.detail[url] ?? null;
      },
      fetchPlatform: async (
        _profile: unknown,
        _videos: unknown,
        _since: unknown,
        opts: PlatformFetchOptions = {},
      ): Promise<PlatformFetchResult> => {
        ctrl.lastOpts[platform] = opts;
        return ctrl.sweep[platform]
          ? ctrl.sweep[platform]()
          : {
              videos: [],
              commentsByVideo: {},
              attempts: [
                {
                  provider: "socialcrawl",
                  actorId: null,
                  kind: "metrics",
                  inputDescription: `socialcrawl ${platform} profile · 3cr · cache:miss`,
                  success: true,
                  runId: null,
                  itemCount: 0,
                  error: null,
                },
              ],
            };
      },
    },
    readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
    config: null,
  });
  return {
    resolveProvider: async (platform: string) => make(platform),
    resolveAllProviders: async () => ({
      tiktok: make("tiktok"),
      youtube: make("youtube"),
      instagram: make("instagram"),
      facebook: make("facebook"),
    }),
  };
});

import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, type TmpCwd } from "./helpers";

const nv = (over: Partial<NormalizedVideo>): NormalizedVideo => ({
  platform: "tiktok",
  originalUrl: "https://example.com/x",
  externalVideoId: null,
  title: null,
  caption: null,
  thumbnailUrl: null,
  publishedAt: "2026-01-01T00:00:00.000Z",
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

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("Option B refresh wiring (cron, real pipeline)", () => {
  let tmp: TmpCwd;
  const resetStore = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  const ENV = {
    CAMPAIGN_START_DATE_ET: "2024-01-01",
    BOOTCAMP_START_DATE: "2024-01-01",
    SOCIALCRAWL_METRICS_ENABLED: "true",
    SOCIALCRAWL_API_KEY: "sc_test",
    SOCIALCRAWL_DAILY_CREDIT_CAP: "350",
    REFRESH_QUIET_HOURS_ENABLED: "false",
    COMMENT_DETAIL_PULL_1_ET: "0", // a comment window is always open → comments on
  } as const;

  beforeEach(async () => {
    tmp = await useTmpCwd();
    resetStore();
    ctrl.sweep = {};
    ctrl.detail = {};
    ctrl.detailCalls = [];
    ctrl.lastOpts = {};
    Object.assign(process.env, ENV);
  });
  afterEach(async () => {
    resetStore();
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
    for (const k of Object.keys(ENV)) delete process.env[k as keyof typeof ENV];
    await tmp.cleanup();
    vi.restoreAllMocks();
  });

  it("tier-gates snapshots, runs the per-post Bootcamp lane, and never touches removed videos", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);

    const insert = (over: Record<string, unknown>) =>
      store.insertVideo({
        campaignId: campaign.id,
        platform: "tiktok",
        profileId: null,
        title: "v",
        caption: null,
        thumbnailUrl: null,
        firstTrackedAt: ago(80 * DAY),
        status: "active",
        episodeGroupId: null,
        sourceStatus: "live",
        errorMessage: null,
        isSeed: false,
        ...over,
      } as Parameters<typeof store.insertVideo>[0]);

    // Hot MTL, in the sweep window, due (last 20m ago > 15m).
    const hot = await insert({
      originalUrl: "https://www.tiktok.com/@x/video/100",
      externalVideoId: "100",
      publishedAt: ago(1 * DAY),
      lastRefreshedAt: ago(20 * MIN),
      hidden: false,
      rawJson: { campaign: "mtl" },
    });
    // Warm MTL, in the sweep window, NOT due (last 5m ago < 30m).
    const warm = await insert({
      originalUrl: "https://www.tiktok.com/@x/video/200",
      externalVideoId: "200",
      publishedAt: ago(20 * DAY),
      lastRefreshedAt: ago(5 * MIN),
      hidden: false,
      rawJson: { campaign: "mtl" },
    });
    // Bootcamp, BEYOND the sweep window, due (last 25h ago > 24h).
    const boot = await insert({
      originalUrl: "https://www.tiktok.com/@x/video/300",
      externalVideoId: "300",
      publishedAt: ago(70 * DAY),
      lastRefreshedAt: ago(25 * HOUR),
      hidden: false,
      rawJson: { campaign: "bootcamp" },
    });
    // Removed from tracking — must never refresh / pull comments / spend credit.
    const removed = await insert({
      originalUrl: "https://www.tiktok.com/@x/video/400",
      externalVideoId: "400",
      publishedAt: ago(2 * DAY),
      lastRefreshedAt: ago(40 * DAY),
      hidden: true,
      rawJson: { campaign: "mtl", tracking: { status: "excluded", reason: "off-campaign" } },
    });

    // The profile sweep returns ONLY the recent (in-window) videos: hot + warm.
    ctrl.sweep.tiktok = () => ({
      videos: [
        nv({ originalUrl: hot.originalUrl, externalVideoId: "100", views: 5000, publishedAt: hot.publishedAt! }),
        nv({ originalUrl: warm.originalUrl, externalVideoId: "200", views: 9000, publishedAt: warm.publishedAt! }),
      ],
      commentsByVideo: {},
      attempts: [
        { provider: "socialcrawl", actorId: null, kind: "metrics", inputDescription: "socialcrawl tiktok profile · 3cr · cache:miss · rem:17000", success: true, runId: null, itemCount: 2, error: null },
      ],
    });
    // Per-post detail for the Bootcamp video (beyond the window).
    ctrl.detail[boot.originalUrl] = nv({ originalUrl: boot.originalUrl, externalVideoId: "300", views: 12000, publishedAt: boot.publishedAt! });

    await runRefresh("cron");

    const snaps = async (id: string) => (await store.listSnapshots(id)).length;

    // Hot MTL (due) snapshotted; warm MTL (not due) carried forward — no snapshot.
    expect(await snaps(hot.id)).toBe(1);
    expect(await snaps(warm.id)).toBe(0);
    // Bootcamp refreshed via the per-post DUE lane.
    expect(await snaps(boot.id)).toBe(1);
    expect((await store.listSnapshots(boot.id))[0].views).toBe(12000);
    expect(ctrl.detailCalls).toContain(boot.originalUrl);

    // Removed video: never snapshotted, never per-post fetched (0 credits).
    expect(await snaps(removed.id)).toBe(0);
    expect(ctrl.detailCalls).not.toContain(removed.originalUrl);

    // The Bootcamp video was refreshed by the per-post lane and logged exactly
    // one 1-credit "due-refresh (bootcamp_daily)" attempt.
    const attempts = await store.listCollectionAttempts(200);
    const bootcampDue = attempts.filter((a) => /due-refresh bootcamp_daily/.test(a.inputDescription));
    expect(bootcampDue.length).toBe(1);
    expect(bootcampDue[0].inputDescription).toMatch(/1cr/);
    // No per-post attempt ever names the removed video's id.
    expect(attempts.some((a) => a.inputDescription.includes(removed.externalVideoId!))).toBe(false);

    // Comments limited to the hot-MTL subset: hot included; warm / bootcamp /
    // removed excluded (their tiers are comment-ineligible by default).
    const ctIds = (ctrl.lastOpts.tiktok?.commentTargets ?? []).map((v) => v.id);
    expect(ctIds).toContain(hot.id);
    expect(ctIds).not.toContain(warm.id);
    expect(ctIds).not.toContain(boot.id);
    expect(ctIds).not.toContain(removed.id);
  });
});
