// Campaign discovery lane: classify new profile-feed candidates (auto-add /
// review / ignore), the real-pipeline discovery behavior (auto-add recent,
// review uncertain, ignore old/invalid, dedup, metrics-only never imports),
// the 2-active-hour cadence, quiet-hours skip, and admin/no-secrets safety.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { classifyDiscoveryCandidate } from "@/lib/eligibility";
import { videoCampaign } from "@/lib/campaigns";
import { PATCH } from "@/app/api/admin/videos/[id]/route";
import { getRefreshPolicyConfig, decideScheduledRefresh } from "@/lib/refresh-policy";
import type { NormalizedVideo, Platform, RefreshRun } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── 1) Candidate classification ───────────────────────────────────────────────
describe("classifyDiscoveryCandidate", () => {
  const START = Date.parse("2026-06-08T04:00:00.000Z");
  const NOW = Date.parse("2026-06-16T12:00:00.000Z");
  const LOOKBACK = 72 * 3600_000;
  const base = (over: Partial<NormalizedVideo>) =>
    classifyDiscoveryCandidate(
      { platform: "tiktok", originalUrl: "https://www.tiktok.com/@x/video/1", externalVideoId: "1", publishedAt: "2026-06-16T00:00:00.000Z", caption: "A day at Wachter", ...over },
      { startMs: START, now: NOW, lookbackMs: LOOKBACK },
    );

  it("AUTO-ADDS a recent (<=72h), eligible candidate on each platform", () => {
    for (const platform of ["tiktok", "instagram", "facebook", "youtube"] as Platform[]) {
      expect(base({ platform }).decision).toBe("add");
    }
  });
  it("REVIEWS an eligible candidate older than the lookback window", () => {
    const r = base({ publishedAt: "2026-06-10T00:00:00.000Z" }); // after start, >72h before NOW
    expect(r).toEqual({ decision: "review", reason: "older_than_discovery_window" });
  });
  it("IGNORES a candidate published before campaign start", () => {
    expect(base({ publishedAt: "2026-06-01T00:00:00.000Z" })).toEqual({ decision: "ignore", reason: "before_campaign_start" });
  });
  it("IGNORES a Jan-1970 / invalid date (never auto-adds)", () => {
    expect(base({ publishedAt: "1970-01-21T00:00:00.000Z" }).decision).toBe("ignore");
    expect(base({ publishedAt: null }).decision).toBe("ignore");
  });
  it("REVIEWS an eligible candidate with no stable platform id", () => {
    expect(base({ externalVideoId: null })).toEqual({ decision: "review", reason: "no_stable_id" });
  });
  it.each([
    { title: "WACHTER training", caption: null },
    { caption: "#bootcamp" },
    { caption: "Boot Camp day one" },
    { caption: "Thanks @WachterInc!" },
    { caption: null, rawJson: { hashtags: [{ name: "Wachter" }] } },
    { caption: null, rawJson: { post: { content: { mentions: [{ username: "wachterinc" }] } } } },
  ])("auto-adds a campaign signal in post text: %j", (over) => {
    expect(base(over)).toEqual({ decision: "add" });
  });
  it.each([
    { caption: "I LOVE Red Bulls..." },
    { title: null, caption: null },
    { caption: "Unrelated post", rawJson: { campaign: "mtl", author: { username: "wachterinc" }, url: "https://wachter.com", comments: [{ text: "Wachter" }] } },
  ])("reviews an eligible post without a campaign signal: %j", (over) => {
    expect(base(over)).toEqual({ decision: "review", reason: "no_campaign_signal" });
  });
});

// ── 2) Cadence + quiet hours ──────────────────────────────────────────────────
describe("discovery cadence + quiet hours", () => {
  const KEYS = ["DISCOVERY_REFRESH_INTERVAL_HOURS", "REFRESH_DISCOVERY_INTERVAL_MINUTES", "SOCIALCRAWL_API_KEY", "SOCIALCRAWL_METRICS_ENABLED"];
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = {}; for (const k of KEYS) saved[k] = process.env[k]; });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
  const at = (etHour: number) => new Date(Date.UTC(2026, 5, 16, etHour + 4, 0, 0));

  it("default discovery cadence is every 2 active hours", () => {
    expect(getRefreshPolicyConfig().discoveryIntervalMin).toBe(120);
  });
  it("DISCOVERY_REFRESH_INTERVAL_HOURS overrides the cadence", () => {
    process.env.DISCOVERY_REFRESH_INTERVAL_HOURS = "3";
    expect(getRefreshPolicyConfig().discoveryIntervalMin).toBe(180);
  });
  it("a scheduled run includes discovery only when due (>= 2h since last discovery)", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    const cfg = getRefreshPolicyConfig();
    const discRun = (minsAgo: number): RefreshRun =>
      ({ id: "r", startedAt: new Date(at(12).getTime() - minsAgo * 60_000).toISOString(), finishedAt: null, status: "success", trigger: "cron", platformsAttempted: [], videosUpdated: 0, commentsUpdated: 0, newVideosDiscovered: 0, errors: [], rawLog: ["mode:full discovery:on comments:off"] } as unknown as RefreshRun);
    // last discovery 30m ago → not due; last discovery 130m ago → due.
    const notDue = decideScheduledRefresh({ now: at(12), recentRuns: [discRun(30)], todaysActorRuns: 0, todaysSocialcrawlCredits: 0, cfg });
    const due = decideScheduledRefresh({ now: at(12), recentRuns: [discRun(130)], todaysActorRuns: 0, todaysSocialcrawlCredits: 0, cfg });
    expect(notDue.action === "run" && notDue.mode.discovery).toBe(false);
    expect(due.action === "run" && due.mode.discovery).toBe(true);
  });
  it("no scheduled discovery during quiet hours", () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    const cfg = getRefreshPolicyConfig();
    const d = decideScheduledRefresh({ now: at(3), recentRuns: [], todaysActorRuns: 0, todaysSocialcrawlCredits: 0, cfg });
    expect(d).toMatchObject({ action: "skip", kind: "quiet" });
  });
});

// ── 3) Integration: real pipeline discovery lane ──────────────────────────────
const ctrl = vi.hoisted(() => ({ tiktok: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/providers/registry", () => {
  const ready = (platform: string) => ({
    provider: {
      providerType: "socialcrawl" as const,
      supportsComments: false,
      supportsDiscovery: true,
      fetchPlatform: async () =>
        platform === "tiktok" && ctrl.tiktok ? ctrl.tiktok() : { videos: [], commentsByVideo: {}, attempts: [] },
    },
    readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
    config: null,
  });
  const resolveProvider = async (p: string) => ready(p);
  const resolveAllProviders = async () => ({ tiktok: await ready("tiktok"), youtube: await ready("youtube"), instagram: await ready("instagram"), facebook: await ready("facebook") });
  return { resolveProvider, resolveAllProviders };
});

import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { getDashboardData } from "@/lib/queries";
import { getStore } from "@/lib/store";
import { stashEnv, useTmpCwd, type TmpCwd } from "./helpers";

const ttUrl = (id: string) => `https://www.tiktok.com/@cybernick0x/video/${id}`;
const nv = (id: string, over: Partial<NormalizedVideo> = {}): NormalizedVideo => ({
  platform: "tiktok", originalUrl: ttUrl(id), externalVideoId: id, title: `v${id}`, caption: null,
  thumbnailUrl: null, publishedAt: "2020-06-01T00:00:00.000Z", authorName: null, authorHandle: null,
  views: 1000, likes: null, comments: null, shares: null, saves: null, bookmarks: null,
  rawJson: { source: "socialcrawl" }, ...over,
});

describe("discovery pipeline (integration)", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    ctrl.tiktok = null;
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE", "ADMIN_PASSWORD"]);
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01"; // decouple from real run date
    process.env.BOOTCAMP_START_DATE = "2020-01-01";
    delete process.env.ADMIN_PASSWORD;
  });
  afterEach(async () => {
    reset();
    restore();
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
    await tmp.cleanup();
  });

  async function seedTracked() {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    await store.insertVideo({
      campaignId: campaign.id, platform: "tiktok", profileId: null, originalUrl: ttUrl("TRACK"),
      externalVideoId: "TRACK", title: "Tracked", caption: null, thumbnailUrl: null,
      publishedAt: new Date(Date.now() - 5 * 86400_000).toISOString(), firstTrackedAt: new Date(Date.now() - 5 * 86400_000).toISOString(),
      lastRefreshedAt: null, status: "active", episodeGroupId: null, sourceStatus: "live", errorMessage: null,
      hidden: false, isSeed: false, rawJson: null,
    });
    return store;
  }

  it("auto-adds recent, reviews old, ignores pre-start/invalid; dedups tracked", async () => {
    const store = await seedTracked();
    const before = (await store.listVideos({ includeHidden: true })).length;
    ctrl.tiktok = async () => ({
      videos: [
        nv("TRACK", { publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 1234 }), // existing tracked → metrics update
        nv("NEW_RECENT", { caption: "Working with @WachterInc #Wachter", publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 5000 }), // ≤72h + signal → MTL
        nv("BOOTCAMP", { title: "Wachter BOOT CAMP", publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 2000 }),
        nv("UNRELATED", { caption: "I LOVE Red Bulls...", publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 50000, rawJson: { source: "socialcrawl", campaign: "mtl" } }),
        nv("OLD_AFTER", { caption: "Wachter", publishedAt: new Date(Date.now() - 12 * 86400_000).toISOString(), views: 9000 }), // >72h after 2020 → review
        nv("PRE_START", { publishedAt: "2019-06-01T00:00:00.000Z", views: 9999 }), // before start → ignore
        nv("EPOCH", { publishedAt: "1970-01-21T00:00:00.000Z", views: 8888 }), // invalid → ignore
      ],
      commentsByVideo: {}, attempts: [],
    });
    await runRefresh("script"); // default mode → discovery on

    const all = await store.listVideos({ includeHidden: true });
    const byExt = (e: string) => all.find((v) => v.externalVideoId === e);
    // recent auto-added (active, visible); old → review (hidden + flagged); pre-start/epoch never created.
    expect(byExt("NEW_RECENT")?.hidden).toBe(false);
    expect(byExt("NEW_RECENT")?.rawJson).toMatchObject({ campaign: "mtl" });
    expect(byExt("BOOTCAMP")?.hidden).toBe(false);
    expect(byExt("BOOTCAMP")?.rawJson).toMatchObject({ campaign: "bootcamp" });
    const unrelated = byExt("UNRELATED");
    expect(unrelated?.hidden).toBe(true);
    expect(unrelated?.rawJson).toMatchObject({ campaign: "unassigned", discoveryReview: true, discoveryReviewReason: "no_campaign_signal" });
    expect(videoCampaign(unrelated!)).toBeNull();
    expect(await store.listSnapshots(unrelated!.id)).toHaveLength(0);
    const old = byExt("OLD_AFTER");
    expect(old?.hidden).toBe(true);
    expect(old?.rawJson).toMatchObject({ campaign: "unassigned", discoveryReview: true, discoveryReviewReason: "older_than_discovery_window" });
    expect(byExt("PRE_START")).toBeUndefined();
    expect(byExt("EPOCH")).toBeUndefined();
    // Four new rows; TRACK was deduped (updated, not re-added).
    expect(all.length).toBe(before + 4);

    // Legacy untagged TRACK still defaults to MTL; review candidates never count.
    expect(videoCampaign(byExt("TRACK")!)).toBe("mtl");
    const dash = await getDashboardData("all");
    expect(dash.kpis.totalViews).toBe(1234 + 5000 + 2000);
    expect((await getDashboardData("all", "mtl")).kpis.totalViews).toBe(1234 + 5000);
    expect((await getDashboardData("all", "bootcamp")).kpis.totalViews).toBe(2000);
  });

  it("keeps unrelated review candidates queued on later refreshes and tags a newly qualifying heal", async () => {
    const store = await seedTracked();
    let caption = "I LOVE Red Bulls...";
    ctrl.tiktok = async () => ({
      videos: [nv("REVIEW", { caption, publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 5000 })],
      commentsByVideo: {}, attempts: [],
    });
    await runRefresh("script");
    await runRefresh("script");
    const queued = (await store.listVideos({ includeHidden: true })).find((v) => v.externalVideoId === "REVIEW")!;
    expect(queued.hidden).toBe(true);
    expect(queued.rawJson).toMatchObject({ campaign: "unassigned", discoveryReview: true, discoveryReviewReason: "no_campaign_signal" });
    expect(await store.listSnapshots(queued.id)).toHaveLength(0);

    caption = "Wachter #bootcamp";
    await runRefresh("script");
    const healed = (await store.getVideo(queued.id))!;
    expect(healed.hidden).toBe(false);
    expect(healed.rawJson).toMatchObject({ campaign: "bootcamp" });
    expect(healed.rawJson).not.toHaveProperty("discoveryReview");
    expect((await getDashboardData("all", "bootcamp")).kpis.totalViews).toBe(5000);
  });

  it.each([
    { caption: "I LOVE Red Bulls...", campaign: "mtl", explicit: undefined },
    { caption: "Wachter bootcamp", campaign: "bootcamp", explicit: undefined },
    { caption: "Wachter", campaign: "bootcamp", explicit: "bootcamp" },
  ])("admin promotion assigns an explicit campaign: %j", async ({ caption, campaign, explicit }) => {
    const store = await seedTracked();
    ctrl.tiktok = async () => ({
      videos: [nv("PROMOTE", { caption, publishedAt: new Date(Date.now() - 12 * 86400_000).toISOString() })],
      commentsByVideo: {}, attempts: [],
    });
    await runRefresh("script");
    const queued = (await store.listVideos({ includeHidden: true })).find((v) => v.externalVideoId === "PROMOTE")!;
    expect(queued.rawJson).toMatchObject({ campaign: "unassigned", discoveryReview: true });
    const res = await PATCH(new NextRequest(`http://localhost/api/admin/videos/${queued.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review: "promote", ...(explicit ? { campaign: explicit } : {}) }),
    }), { params: Promise.resolve({ id: queued.id }) });
    expect(res.status).toBe(200);
    const promoted = (await store.getVideo(queued.id))!;
    expect(promoted.hidden).toBe(false);
    expect(promoted.rawJson).toMatchObject({ campaign });
    expect(promoted.rawJson).not.toHaveProperty("discoveryReview");
    expect(promoted.rawJson).not.toHaveProperty("discoveryReviewReason");
    // The next provider refresh preserves the admin approval and starts counting.
    await runRefresh("script");
    expect((await getDashboardData("all", campaign as "mtl" | "bootcamp")).kpis.totalViews).toBe(1000);
  });

  it("metrics-only refresh never imports unmatched candidates", async () => {
    const store = await seedTracked();
    const before = (await store.listVideos({ includeHidden: true })).length;
    ctrl.tiktok = async () => ({
      videos: [nv("NEW_RECENT", { publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString() })],
      commentsByVideo: {}, attempts: [],
    });
    await runRefresh("script", { mode: "metrics" }); // discovery OFF
    const all = await store.listVideos({ includeHidden: true });
    expect(all.find((v) => v.externalVideoId === "NEW_RECENT")).toBeUndefined();
    expect(all.length).toBe(before);
  });
});

// ── 4) Safety + admin-only ────────────────────────────────────────────────────
describe("discovery safety", () => {
  it("admin refresh route is admin-gated and accepts the mode lane", () => {
    const route = read("src/app/api/refresh/route.ts");
    expect(route).toContain("checkAdminRequest");
    expect(route).toMatch(/"metrics".*"discovery".*"full"/s);
  });
  it("discovery admin components expose no secrets / provider internals / actor IDs", () => {
    for (const f of ["src/app/admin/discovery-controls.tsx", "src/app/admin/review-candidates.tsx"]) {
      const src = read(f);
      expect(src).not.toMatch(/sc_[A-Za-z0-9]{20,}/);
      expect(src).not.toMatch(/actorId|x-api-key|providerType/);
    }
  });
});
