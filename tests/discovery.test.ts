// Campaign discovery lane: classify new profile-feed candidates (auto-add /
// review / ignore), the real-pipeline discovery behavior (auto-add recent,
// review uncertain, ignore old/invalid, dedup, metrics-only never imports),
// the 2-active-hour cadence, quiet-hours skip, and admin/no-secrets safety.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyDiscoveryCandidate } from "@/lib/eligibility";
import { getRefreshPolicyConfig, decideScheduledRefresh } from "@/lib/refresh-policy";
import type { NormalizedVideo, Platform, RefreshRun } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── 1) Candidate classification ───────────────────────────────────────────────
describe("classifyDiscoveryCandidate", () => {
  const START = Date.parse("2026-06-08T04:00:00.000Z");
  const NOW = Date.parse("2026-06-16T12:00:00.000Z");
  const LOOKBACK = 72 * 3600_000;
  const base = (over: Partial<{ platform: Platform; originalUrl: string | null; externalVideoId: string | null; publishedAt: string | null }>) =>
    classifyDiscoveryCandidate(
      { platform: "tiktok", originalUrl: "https://www.tiktok.com/@x/video/1", externalVideoId: "1", publishedAt: "2026-06-16T00:00:00.000Z", ...over },
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
import { useTmpCwd, type TmpCwd } from "./helpers";

const ttUrl = (id: string) => `https://www.tiktok.com/@cybernick0x/video/${id}`;
const nv = (id: string, over: Partial<NormalizedVideo> = {}): NormalizedVideo => ({
  platform: "tiktok", originalUrl: ttUrl(id), externalVideoId: id, title: `v${id}`, caption: null,
  thumbnailUrl: null, publishedAt: "2020-06-01T00:00:00.000Z", authorName: null, authorHandle: null,
  views: 1000, likes: null, comments: null, shares: null, saves: null, bookmarks: null,
  rawJson: { source: "socialcrawl" }, ...over,
});

describe("discovery pipeline (integration)", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    ctrl.tiktok = null;
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01"; // decouple from real run date
  });
  afterEach(async () => {
    reset();
    delete process.env.CAMPAIGN_START_DATE_ET;
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
        nv("NEW_RECENT", { publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 5000 }), // ≤72h → add
        nv("OLD_AFTER", { publishedAt: new Date(Date.now() - 12 * 86400_000).toISOString(), views: 9000 }), // >72h after 2020 → review
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
    const old = byExt("OLD_AFTER");
    expect(old?.hidden).toBe(true);
    expect((old?.rawJson as { discoveryReview?: boolean } | null)?.discoveryReview).toBe(true);
    expect(byExt("PRE_START")).toBeUndefined();
    expect(byExt("EPOCH")).toBeUndefined();
    // exactly 2 new rows (recent + review); TRACK was deduped (updated, not re-added).
    expect(all.length).toBe(before + 2);

    // Totals count the tracked + the auto-added recent, NOT the review candidate.
    const dash = await getDashboardData("all");
    expect(dash.kpis.totalViews).toBe(1234 + 5000);
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
