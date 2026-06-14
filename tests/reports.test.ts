// Reports page: pure aggregation helpers (real data only — nulls never become
// zeros), an integration smoke test against the real query stack, and
// source-level read-only / no-secrets invariants for the public report.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterComments,
  filterVideos,
  metricValue,
  rankVideos,
  rollupByPlatform,
  rollupComments,
  rollupConcepts,
  rollupVideos,
  sumReal,
  type ReportComment,
  type ReportVideo,
} from "@/lib/reports";
import { buildReportsData } from "@/lib/reports-data";
import { getStore } from "@/lib/store";
import { makeSnapshot, useTmpCwd, type TmpCwd } from "./helpers";

const REPO_ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf-8");

let seq = 0;
function rv(over: Partial<ReportVideo> = {}): ReportVideo {
  seq += 1;
  return {
    id: `v${seq}`,
    platform: "tiktok",
    title: `Video ${seq}`,
    url: `https://example.com/${seq}`,
    thumbnailUrl: null,
    episodeId: null,
    episodeName: null,
    publishedAt: null,
    views: 1000,
    engagements: 100,
    engagementRate: 0.1,
    comments: 10,
    periodGrowth: 50,
    periodCoversFull: true,
    stale: false,
    audienceCaptured: 0,
    audienceNeedsResponse: 0,
    audienceTopSignal: null,
    ...over,
  };
}
function rc(over: Partial<ReportComment> = {}): ReportComment {
  return { platform: "tiktok", episodeId: null, sentiment: "neutral", needsResponse: false, recruiting: false, wachter: false, ...over };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("sumReal", () => {
  it("sums only real numbers and returns null when nothing is real", () => {
    expect(sumReal([1, 2, 3])).toBe(6);
    expect(sumReal([1, null, 3])).toBe(4); // null is skipped, not coerced to 0
    expect(sumReal([null, null])).toBeNull(); // no fake zero
    expect(sumReal([])).toBeNull();
    expect(sumReal([0, null])).toBe(0); // a real 0 still counts
  });
});

describe("filterVideos / filterComments", () => {
  const vids = [
    rv({ platform: "tiktok", episodeId: "e1" }),
    rv({ platform: "facebook", episodeId: "e1" }),
    rv({ platform: "facebook", episodeId: "e2" }),
  ];
  it("filters by platform and concept independently and together", () => {
    expect(filterVideos(vids, { platform: "all", conceptId: "all" })).toHaveLength(3);
    expect(filterVideos(vids, { platform: "facebook", conceptId: "all" })).toHaveLength(2);
    expect(filterVideos(vids, { platform: "all", conceptId: "e1" })).toHaveLength(2);
    expect(filterVideos(vids, { platform: "facebook", conceptId: "e2" })).toHaveLength(1);
  });
  it("filters comments the same way", () => {
    const cs = [rc({ platform: "tiktok", episodeId: "e1" }), rc({ platform: "facebook", episodeId: "e2" })];
    expect(filterComments(cs, { platform: "facebook", conceptId: "all" })).toHaveLength(1);
    expect(filterComments(cs, { platform: "all", conceptId: "e1" })).toHaveLength(1);
  });
});

describe("rollupVideos", () => {
  it("aggregates real metrics; ER = engagements / views", () => {
    const r = rollupVideos([rv({ views: 1000, engagements: 100 }), rv({ views: 1000, engagements: 300 })]);
    expect(r.count).toBe(2);
    expect(r.totalViews).toBe(2000);
    expect(r.totalEngagements).toBe(400);
    expect(r.engagementRate).toBeCloseTo(0.2, 6);
    expect(r.totalGrowth).toBe(100);
  });
  it("returns null aggregates (not zeros) when no real data is present", () => {
    const r = rollupVideos([rv({ views: null, engagements: null, comments: null, periodGrowth: null })]);
    expect(r.totalViews).toBeNull();
    expect(r.totalEngagements).toBeNull();
    expect(r.totalComments).toBeNull();
    expect(r.totalGrowth).toBeNull();
    expect(r.engagementRate).toBeNull(); // no views → ER undefined, not 0
  });
});

describe("metricValue / rankVideos", () => {
  it("reads the focused metric and ranks descending, dropping null-metric videos", () => {
    const a = rv({ views: 100, periodGrowth: 5 });
    const b = rv({ views: 900, periodGrowth: null });
    const c = rv({ views: 400, periodGrowth: 50 });
    expect(metricValue(b, "views")).toBe(900);
    // By views: b, c, a
    expect(rankVideos([a, b, c], "views").map((v) => v.id)).toEqual([b.id, c.id, a.id]);
    // By growth: c, a — b drops out (null growth)
    expect(rankVideos([a, b, c], "growth").map((v) => v.id)).toEqual([c.id, a.id]);
  });
});

describe("rollupByPlatform / rollupConcepts", () => {
  it("buckets per platform, omitting platforms with no videos", () => {
    const rolls = rollupByPlatform([rv({ platform: "tiktok", views: 100 }), rv({ platform: "facebook", views: 200 })]);
    expect(rolls.map((r) => r.platform).sort()).toEqual(["facebook", "tiktok"]);
    expect(rolls.find((r) => r.platform === "facebook")?.totalViews).toBe(200);
  });
  it("buckets per concept and adds an Unassigned bucket when needed", () => {
    const concepts = [{ id: "e1", name: "Concept One" }];
    const rolls = rollupConcepts([rv({ episodeId: "e1", views: 100 }), rv({ episodeId: null, views: 50 })], concepts);
    expect(rolls.find((r) => r.id === "e1")?.totalViews).toBe(100);
    expect(rolls.find((r) => r.id === "__unassigned")?.totalViews).toBe(50);
  });
});

describe("rollupComments", () => {
  it("counts sentiment, needs-response, recruiting, and Wachter mentions", () => {
    const cs = [
      rc({ sentiment: "positive" }),
      rc({ sentiment: "question", needsResponse: true }),
      rc({ sentiment: "negative", needsResponse: true }),
      rc({ sentiment: "neutral", recruiting: true, wachter: true }),
    ];
    const r = rollupComments(cs);
    expect(r.total).toBe(4);
    expect(r.positive).toBe(1);
    expect(r.questions).toBe(1);
    expect(r.negative).toBe(1);
    expect(r.needsResponse).toBe(2);
    expect(r.recruiting).toBe(1);
    expect(r.wachter).toBe(1);
  });
});

// ── Integration: buildReportsData over the real query stack ───────────────────

describe("buildReportsData (real query stack)", () => {
  let tmp: TmpCwd;
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

  it("returns a public-safe payload built from real snapshots", async () => {
    const store = getStore();
    const campaign = await store.upsertCampaign({ name: "C", creatorName: "Nick", company: "Wachter", startDate: null });
    const v = await store.insertVideo({
      campaignId: campaign.id,
      platform: "facebook",
      profileId: null,
      originalUrl: "https://www.facebook.com/reel/55",
      externalVideoId: "55",
      title: "Reel 55",
      caption: null,
      thumbnailUrl: "https://thumb.jpg",
      publishedAt: null,
      firstTrackedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      lastRefreshedAt: new Date().toISOString(),
      status: "active",
      episodeGroupId: null,
      sourceStatus: "live",
      errorMessage: null,
      hidden: false,
      isSeed: false,
      rawJson: { secret: "do-not-leak" },
    });
    await store.addSnapshot(makeSnapshot({ videoId: v.id, capturedAt: new Date(Date.now() - 3_600_000).toISOString(), views: 5000, likes: 200, comments: 12 }));
    await store.upsertComment({
      videoId: v.id, platform: "facebook", externalCommentId: "c1", authorName: "a", text: "are you hiring?",
      postedAt: new Date().toISOString(), likes: 0, replyCount: 0, sentiment: "question", needsResponse: true,
      tags: ["hiring"], permalink: null, capturedAt: new Date().toISOString(), rawJson: null,
    });

    const data = await buildReportsData("all");
    const row = data.videos.find((x) => x.id === v.id)!;
    expect(row).toBeDefined();
    expect(row.views).toBe(5000); // confirmed real views
    expect(row.title).toBe("Reel 55");
    // Public-safe: the payload exposes only known primitive fields — no rawJson.
    expect(Object.keys(row)).not.toContain("rawJson");
    expect(JSON.stringify(data)).not.toContain("do-not-leak");
    // Aggregations reflect the real row.
    const roll = rollupVideos(filterVideos(data.videos, { platform: "all", conceptId: "all" }));
    expect(roll.totalViews).toBe(5000);
    // Comment mapped with recruiting flag derived from tags.
    expect(data.comments.some((c) => c.recruiting && c.needsResponse)).toBe(true);
    // Concepts list comes from real episode groups (seeded defaults).
    expect(Array.isArray(data.concepts)).toBe(true);
    expect(data.meta.range).toBe("all");
  });
});

// ── Source-level: read-only + no secrets ─────────────────────────────────────

describe("Reports page structure & safety (source-level)", () => {
  const page = read("src/app/reports/page.tsx");
  const studio = read("src/app/reports/reports-studio.tsx");
  const lib = read("src/lib/reports.ts");
  const serverLib = read("src/lib/reports-data.ts");

  it("is read-only — no refresh/admin/mutation endpoints", () => {
    for (const src of [page, studio, lib, serverLib]) {
      expect(src).not.toContain("/api/refresh");
      expect(src).not.toContain("/api/cron");
      expect(src).not.toContain("/api/admin");
      expect(src).not.toContain("RefreshButton");
    }
    // The studio performs no data fetches and no POSTs.
    expect(studio).not.toMatch(/fetch\(/);
    expect(studio).not.toMatch(/method:\s*["']POST["']/);
  });
  it("exposes no actor IDs or vendor names", () => {
    for (const src of [page, studio, lib]) {
      expect(src).not.toMatch(/apify/i);
      expect(src).not.toContain("actorId");
    }
  });
  it("offers all four report types and the required filters", () => {
    for (const label of ["Executive Summary", "Platform Breakdown", "Content Concepts", "Audience Signals"]) {
      expect(lib).toContain(label);
    }
    for (const control of ["Report", "Date range", "Platform", "Content concept", "Metric focus"]) {
      expect(studio).toContain(control);
    }
  });
  it("supports print and presentation modes", () => {
    expect(studio).toContain("window.print()");
    expect(studio).toContain("Present");
    expect(studio).toContain("report-print-root");
    expect(studio).toContain("report-no-print");
  });
  it("targets a 16:9 / 1920×1080 canvas", () => {
    expect(studio).toContain("1280");
    expect(studio).toContain("720");
    expect(studio).toMatch(/1920/);
  });
  it("defaults match the spec: 7d / All / All / Views / Executive Summary", () => {
    expect(lib).toContain('range: "7d"');
    expect(lib).toContain('platform: "all"');
    expect(lib).toContain('conceptId: "all"');
    expect(lib).toContain('metric: "views"');
    expect(lib).toContain('type: "executive"');
  });
  it("renders the spec'd executive header (logo + Campaign Report + last refresh)", () => {
    expect(studio).toContain("wachter-creator-logo");
    expect(studio).toContain("Campaign Report");
    expect(studio).toContain("Last refreshed");
  });
  it("renders the full 7-KPI executive row (board labels)", () => {
    for (const kpi of ["Total reach", "Views gained", "Engagements", "Engagement rate", "Comments", "Top platform", "Videos tracked"]) {
      expect(studio).toContain(kpi);
    }
  });
  it("keeps platform contribution + provenance footer", () => {
    expect(studio).toContain("Platform contribution");
    expect(studio).toContain("Data from public platform metrics");
  });
});

// ── Executive Summary: board-ready refinement (Phase 6 / Reports v3) ──────────

describe("Executive Summary is board-level, not operational", () => {
  const studio = read("src/app/reports/reports-studio.tsx");

  it("drops the individual-video + audience-triage cards from the default report", () => {
    // No "need a response" anywhere in the report studio (it lived only in the
    // old Executive Summary audience card).
    expect(studio).not.toContain("need a response");
    // The old per-video Executive cards are gone.
    expect(studio).not.toContain("Top growth video");
    expect(studio).not.toContain("Top overall video");
  });

  it("replaces them with campaign-level visuals", () => {
    expect(studio).toContain("PlatformContribution");
    expect(studio).toContain("Growth by platform"); // share of selected-period growth
    expect(studio).toContain("Campaign momentum");
    expect(studio).toContain("Engagement quality");
    expect(studio).toContain("Leading theme");
  });

  it("platform contribution uses real selected-period growth (falls back to views)", () => {
    expect(studio).toContain("rolls.map((r) => r.totalGrowth)");
    expect(studio).toContain("const byGrowth = totalGrowth > 0;");
  });

  it("comments remain a plain metric (KPI + engagement quality), not triage", () => {
    expect(studio).toContain('label="Comments"');
    // Engagement-quality comments stat.
    expect(studio).toMatch(/Comments"\s+value=\{formatCompact\(roll\.totalComments\)\}/);
  });

  it("campaign momentum uses a real-points sparkline (no fakes)", () => {
    expect(studio).toContain("data.overallTrend.map((p) => p.views).filter");
    expect(studio).toContain("<Sparkline");
  });

  it("operational labels are not used in the report", () => {
    for (const banned of ["Response opportunities", "Comment hot spots", "Needs response", "recruiting comments"]) {
      expect(studio).not.toContain(banned);
    }
  });

  it("Audience Signals report type still surfaces response opportunities", () => {
    expect(studio).toContain("Response hot spots");
    expect(studio).toContain("Need response");
    expect(studio).toContain("Recruiting interest");
  });
});

// ── Export / presentation workflow (PowerPoint-ready) ────────────────────────

describe("Reports export & presentation workflow", () => {
  const studio = read("src/app/reports/reports-studio.tsx");
  const css = read("src/app/globals.css");
  const pkg = JSON.parse(read("package.json"));

  it("Presentation Mode is a clean, fully-opaque screenshot workspace", () => {
    // Solid backdrop (no alpha) so the underlying page never bleeds into a
    // screenshot. The old rgba(...,0.97) ghosted the sidebar through.
    expect(studio).toContain('background: "#04060b"');
    expect(studio).not.toContain("rgba(3,5,9,0.97)");
    // Full-screen overlay that is excluded from print and centers the slide.
    expect(studio).toContain("report-no-print fixed inset-0 z-[100]");
    // Accessible dialog semantics.
    expect(studio).toContain('role="dialog"');
    expect(studio).toContain('aria-modal="true"');
  });

  it("Presentation Mode keeps a small exit control + Esc, no filters inside", () => {
    expect(studio).toContain('aria-label="Exit presentation"');
    expect(studio).toContain('if (e.key === "Escape") closePresent()');
    // The filter controls (Segmented/Dropdown) live OUTSIDE the overlay — the
    // overlay only renders <Slide/> plus nav/exit chrome, never the filter bar.
    const overlayStart = studio.indexOf("Presentation overlay");
    const overlay = studio.slice(overlayStart);
    expect(overlay).not.toContain("<Segmented");
    expect(overlay).not.toContain("<Dropdown");
  });

  it("Print mode prints only the canvas, hides chrome, landscape, one page, dark", () => {
    const printBlock = css.slice(css.indexOf("@media print"));
    expect(printBlock).toContain("size: landscape");
    expect(printBlock).toContain(".report-no-print");
    expect(printBlock).toContain("display: none");
    // The canvas (and only it) stays visible and keeps its dark colors.
    expect(printBlock).toContain(".report-print-root");
    expect(printBlock).toContain("print-color-adjust: exact");
    // No mid-slide page breaks — the Executive Summary fits one page.
    expect(printBlock).toContain("break-inside: avoid");
  });

  it("shows landscape print guidance and PowerPoint screenshot guidance", () => {
    expect(studio).toContain("use landscape orientation for best results");
    expect(studio).toContain("Best for PowerPoint");
    expect(studio).toContain("take a screenshot");
  });

  it("does NOT ship a fragile client-side PNG exporter (Present+screenshot is higher fidelity)", () => {
    // PNG export via html-to-image hung on font embedding; intentionally skipped.
    expect(pkg.dependencies?.["html-to-image"]).toBeUndefined();
    expect(studio).not.toContain("html-to-image");
    expect(studio).not.toContain("toPng");
  });

  it("Presentation overlay is the only print-hidden full-screen layer (read-only, no refresh)", () => {
    expect(studio).not.toContain("RefreshButton");
    expect(studio).not.toMatch(/fetch\(/);
  });
});
