// Phase 4 Videos command center: range-aware period growth + sparklines from
// REAL snapshots, Growth Leaders ranked by selected-period growth (not
// lifetime views), per-video audience signals, and read-only/safety
// invariants. Integration tests run against JsonStore via the real
// getVideosPageData query.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { videoGrowthInWindow, viewSparkline, RANGE_MS } from "@/lib/range";
import { getVideosPageData } from "@/lib/queries";
import { getStore } from "@/lib/store";
import { makeSnapshot } from "./helpers";
import { useTmpCwd, type TmpCwd } from "./helpers";
import type { MetricSnapshot } from "@/lib/types";

const REPO_ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf-8");

// ── Pure helpers: real data only ────────────────────────────────────────────

describe("videoGrowthInWindow", () => {
  const NOW = new Date("2026-06-13T12:00:00.000Z");
  const at = (h: number, views: number | null): MetricSnapshot =>
    makeSnapshot({ videoId: "v", capturedAt: new Date(NOW.getTime() - h * 3_600_000).toISOString(), views });

  it("computes last-minus-first confirmed views INSIDE the window", () => {
    const snaps = [at(30, 1000), at(20, 1500), at(1, 1800)];
    const w24 = videoGrowthInWindow(snaps, new Date(NOW.getTime() - RANGE_MS["24h"]));
    expect(w24.gained).toBe(300); // 1800 - 1500 (the -30h reading is outside 24h)
    const w7d = videoGrowthInWindow(snaps, new Date(NOW.getTime() - RANGE_MS["7d"]));
    expect(w7d.gained).toBe(800); // full history
  });
  it("is null with fewer than two confirmed readings in the window (no fakes)", () => {
    expect(videoGrowthInWindow([at(1, 500)], new Date(NOW.getTime() - RANGE_MS["24h"])).gained).toBeNull();
    expect(videoGrowthInWindow([at(2, 500), at(1, null)], new Date(NOW.getTime() - RANGE_MS["24h"])).gained).toBeNull();
  });
  it("coversFull reflects whether history reaches the window start", () => {
    // History predates the window (a reading at -30h, before the 24h start):
    const full = videoGrowthInWindow([at(30, 1), at(12, 1400), at(1, 2000)], new Date(NOW.getTime() - RANGE_MS["24h"]));
    expect(full.gained).toBe(600);
    expect(full.coversFull).toBe(true);
    // Tracking only began inside the window (earliest reading at -20h):
    const partial = videoGrowthInWindow([at(20, 1), at(1, 9)], new Date(NOW.getTime() - RANGE_MS["24h"]));
    expect(partial.gained).toBe(8);
    expect(partial.coversFull).toBe(false);
  });
});

describe("viewSparkline", () => {
  const NOW = new Date("2026-06-13T12:00:00.000Z");
  const series = (n: number): MetricSnapshot[] =>
    Array.from({ length: n }, (_, i) =>
      makeSnapshot({ videoId: "v", capturedAt: new Date(NOW.getTime() - (n - i) * 3_600_000).toISOString(), views: 100 + i * 10 }),
    );
  it("returns null below 3 real points", () => {
    expect(viewSparkline(series(2), new Date(0))).toBeNull();
  });
  it("returns the real values when within maxPoints", () => {
    expect(viewSparkline(series(5), new Date(0))).toEqual([100, 110, 120, 130, 140]);
  });
  it("downsamples to maxPoints, keeping first and last real readings", () => {
    const out = viewSparkline(series(40), new Date(0), 16)!;
    expect(out.length).toBe(16);
    expect(out[0]).toBe(100);
    expect(out[out.length - 1]).toBe(100 + 39 * 10);
  });
});

// ── Integration: getVideosPageData ──────────────────────────────────────────

describe("getVideosPageData (range-aware, real data)", () => {
  let tmp: TmpCwd;
  // getStore() caches a JsonStore on globalThis keyed to the cwd at
  // construction. Reset it per test so getVideosPageData builds a fresh store
  // rooted in the new tmp cwd (whose data/ dir the constructor creates).
  const resetStore = () => {
    (globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined;
  };
  beforeEach(async () => {
    tmp = await useTmpCwd();
    resetStore();
  });
  afterEach(async () => {
    resetStore();
    await tmp.cleanup();
  });

  async function seedVideo(opts: {
    id: string;
    views: Array<[hoursAgo: number, value: number]>;
    comments?: Array<{ needsResponse: boolean; sentiment?: string }>;
  }) {
    const store = getStore();
    const campaign = await store.upsertCampaign({ name: "C", creatorName: "N", company: "W", startDate: null });
    const v = await store.insertVideo({
      campaignId: campaign.id,
      platform: "tiktok",
      profileId: null,
      originalUrl: `https://www.tiktok.com/@x/video/${opts.id}`,
      externalVideoId: opts.id,
      title: `Video ${opts.id}`,
      caption: null,
      thumbnailUrl: "https://p16.tiktokcdn.com/x.jpg",
      publishedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      firstTrackedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      lastRefreshedAt: new Date().toISOString(),
      status: "active",
      episodeGroupId: null,
      sourceStatus: "live",
      errorMessage: null,
      hidden: false,
      isSeed: false,
      rawJson: null,
    });
    for (const [h, val] of opts.views) {
      await store.addSnapshot(
        makeSnapshot({ videoId: v.id, capturedAt: new Date(Date.now() - h * 3_600_000).toISOString(), views: val, likes: 10, comments: 2 }),
      );
    }
    for (const c of opts.comments ?? []) {
      await store.upsertComment({
        videoId: v.id,
        platform: "tiktok",
        externalCommentId: Math.random().toString(36).slice(2),
        authorName: "a",
        text: "hi?",
        postedAt: new Date().toISOString(),
        likes: 0,
        replyCount: 0,
        sentiment: (c.sentiment as never) ?? "question",
        needsResponse: c.needsResponse,
        tags: [],
        permalink: null,
        capturedAt: new Date().toISOString(),
        rawJson: null,
      });
    }
    return v.id;
  }

  it("rows carry period growth, sparkline, and audience signals from real data", async () => {
    const id = await seedVideo({
      id: "111",
      views: [[48, 1000], [12, 1400], [1, 2000]],
      comments: [{ needsResponse: true }, { needsResponse: false }],
    });
    const data = await getVideosPageData("all");
    const row = data.rows.find((r) => r.video.id === id)!;
    expect(row.periodGrowth).toBe(1000); // 2000 - 1000 across all history
    expect(row.sparkline).toEqual([1000, 1400, 2000]);
    expect(row.audience.capturedComments).toBe(2);
    expect(row.audience.needsResponse).toBe(1);
    expect(data.range).toBe("all");
    expect(data.historyStart).not.toBeNull();
  });

  it("period growth follows the selected range, not lifetime", async () => {
    const id = await seedVideo({ id: "222", views: [[48, 1000], [12, 1400], [1, 2000]] });
    const g24 = (await getVideosPageData("24h")).rows.find((r) => r.video.id === id)!.periodGrowth;
    const gAll = (await getVideosPageData("all")).rows.find((r) => r.video.id === id)!.periodGrowth;
    expect(g24).toBe(600); // 2000 - 1400 (only the -12h and -1h readings fall in 24h)
    expect(gAll).toBe(1000); // full history
    expect(g24).toBeLessThan(gAll!);
  });

  it("Growth Leaders rank by period growth: a small-total fast climber beats a big-total flat video", async () => {
    const flatBig = await seedVideo({ id: "big", views: [[48, 100000], [1, 100050]] }); // huge total, +50
    const fastSmall = await seedVideo({ id: "small", views: [[20, 100], [1, 5100]] }); // small total, +5000
    const rows = (await getVideosPageData("all")).rows.filter((r) => ["big", "small"].includes(r.video.externalVideoId ?? ""));
    const ranked = [...rows].sort((a, b) => (b.periodGrowth ?? -1) - (a.periodGrowth ?? -1));
    expect(ranked[0].video.id).toBe(fastSmall); // fast climber leads by GROWTH
    // ...even though by lifetime views the order is reversed:
    const byViews = [...rows].sort((a, b) => (b.confirmed.views?.value ?? 0) - (a.confirmed.views?.value ?? 0));
    expect(byViews[0].video.id).toBe(flatBig);
  });
});

// ── Source-level: read-only + safety + structure ────────────────────────────

describe("Videos page structure & safety (source-level)", () => {
  const page = read("src/app/videos/page.tsx");
  const explorer = read("src/app/videos/videos-explorer.tsx");
  const spark = read("src/components/charts/sparkline.tsx");

  it("public view is read-only — no refresh controls, no cost-bearing endpoints", () => {
    for (const src of [page, explorer]) {
      expect(src).not.toContain("RefreshButton");
      expect(src).not.toContain("/api/refresh");
      expect(src).not.toContain("/api/cron/refresh");
    }
  });
  it("the ONLY mutation the explorer can make is the admin-gated remove/restore route", () => {
    // The explorer now supports admin remove/restore. Its single fetch target is
    // the admin videos route (guardAdmin-enforced server-side); it never hits a
    // public/cron mutation, and the control object is null unless isAdmin.
    const fetchTargets = [...explorer.matchAll(/fetch\(`([^`]+)`/g)].map((m) => m[1]);
    expect(fetchTargets.length).toBe(1);
    expect(fetchTargets[0]).toContain("/api/admin/videos/");
    expect(explorer).toContain("const admin: AdminControls | null = isAdmin ? { pendingId, onRemove: remove } : null;");
    expect(explorer).toContain("{admin && <RemoveButton");
  });
  it("exposes no actor IDs or vendor names", () => {
    for (const src of [page, explorer]) {
      expect(src).not.toMatch(/apify/i);
      expect(src).not.toContain("actorId");
    }
  });
  it("renders Growth Leaders, range awareness, and a read-only detail drawer", () => {
    expect(explorer).toContain("Growth leaders");
    expect(explorer).toContain('role="dialog"');
    expect(explorer).toContain("aria-modal");
    expect(page).toContain("RangeSwitcher");
    expect(page).toContain('basePath="/videos"');
  });
  it("defaults sorting to period growth (not lifetime views)", () => {
    expect(explorer).toContain('useState<SortKey>("growth")');
  });
  it("renders the status badges from real fields", () => {
    for (const label of ["Surging", "New", "Needs response", "Verified", "No thumbnail", "Awaiting views", "Stale"]) {
      expect(explorer).toContain(label);
    }
  });
  it("offers the required filters", () => {
    for (const f of ["Filter by platform", "Filter by episode", "Filter by status", "Has comments"]) {
      expect(explorer).toContain(f);
    }
  });
  it("sparkline uses only the real points it is given — no invented data", () => {
    expect(spark).not.toMatch(/Math\.random/);
    expect(spark).toContain("never interpolates");
    expect(explorer).toContain("<Sparkline");
  });
});
