// Phase 7 — Campaign Milestones engine (unit), Alerts badge design, exact hero
// total, and milestone placement (source-level). Node test env: the engine is
// pure so it gets real behavioral tests; UI is asserted at source level like
// the other component tests.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  computeMilestones,
  selectTopMilestones,
  topMilestone,
  compactThreshold,
  type MilestoneInput,
} from "@/lib/milestones";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// A realistic baseline input; individual tests override fields.
const base: MilestoneInput = {
  totalViews: 1_623_195,
  totalEngagements: 52_400,
  totalComments: 1_240,
  periodViewsGained: 120_000,
  rangeLabel: "last 7 days",
  platforms: [
    { platform: "tiktok", label: "TikTok", views: 900_000, viewsGained: 40_000 },
    { platform: "instagram", label: "Instagram Reels", views: 500_000, viewsGained: 60_000 },
    { platform: "youtube", label: "YouTube Shorts", views: 150_000, viewsGained: 15_000 },
    { platform: "facebook", label: "Facebook Reels", views: 73_195, viewsGained: 5_000 },
  ],
  topVideo: { title: "PoE lighting walkthrough", platform: "tiktok", views: 681_500 },
  trend: [
    { t: "2026-06-13T00:00:00Z", views: 1_500_000 },
    { t: "2026-06-13T12:00:00Z", views: 1_560_000 },
    { t: "2026-06-14T00:00:00Z", views: 1_623_195 },
  ],
  topConcept: { name: "Mount Laurel interviews", views: 410_000 },
};

const byType = (input: MilestoneInput) => {
  const map = new Map<string, ReturnType<typeof computeMilestones>[number]>();
  for (const m of computeMilestones(input)) map.set(m.type, m); // first per type is fine for these
  return map;
};

describe("milestone engine — total reach", () => {
  it("fires the HIGHEST crossed reach threshold as a major milestone", () => {
    const m = computeMilestones(base).find((x) => x.type === "reach");
    expect(m).toBeTruthy();
    expect(m!.value).toBe(1_500_000);
    expect(m!.title).toBe("1.5M views crossed");
    expect(m!.severity).toBe("major");
    expect(m!.description).toContain("1,500,000");
  });
  it("does not fire below the first threshold", () => {
    expect(computeMilestones({ ...base, totalViews: 30_000 }).some((m) => m.type === "reach")).toBe(false);
  });
  it("treats null totals as unavailable (never zero, never a milestone)", () => {
    expect(computeMilestones({ ...base, totalViews: null }).some((m) => m.type === "reach")).toBe(false);
  });
});

describe("milestone engine — platform leadership", () => {
  it("names the growth leader with a real share of period growth", () => {
    const m = computeMilestones(base).find((x) => x.id === "lead-growth-instagram");
    expect(m).toBeTruthy();
    expect(m!.platform).toBe("instagram"); // 60k of 120k growth
    expect(m!.description).toMatch(/50%|5\d%/);
    expect(m!.severity).toBe("major"); // >=50% share
  });
  it("adds the total-views leader only when it's a DIFFERENT platform", () => {
    // TikTok leads total views (900k); Instagram leads growth — both should show.
    const ids = computeMilestones(base).map((m) => m.id);
    expect(ids).toContain("lead-views-tiktok");
    expect(ids).toContain("lead-growth-instagram");
  });
  it("does not double-report when the same platform leads both", () => {
    const sameLeader: MilestoneInput = {
      ...base,
      platforms: [
        { platform: "tiktok", label: "TikTok", views: 900_000, viewsGained: 90_000 },
        { platform: "instagram", label: "Instagram Reels", views: 100_000, viewsGained: 10_000 },
      ],
    };
    const leadership = computeMilestones(sameLeader).filter((m) => m.type === "platform_leadership");
    expect(leadership).toHaveLength(1);
    expect(leadership[0].platform).toBe("tiktok");
  });
});

describe("milestone engine — video / engagement / comment / concept", () => {
  it("fires top-video threshold from real views", () => {
    const m = computeMilestones(base).find((x) => x.type === "video_performance");
    expect(m!.title).toBe("Top video crossed 500K");
    expect(m!.description).toContain("681,500");
    expect(m!.videoTitle).toBe("PoE lighting walkthrough");
  });
  it("fires engagement + comment thresholds", () => {
    const map = byType(base);
    expect(map.get("engagement")!.value).toBe(50_000);
    expect(map.get("comment")!.value).toBe(1_000);
  });
  it("fires the leading concept when provided", () => {
    const m = computeMilestones(base).find((x) => x.type === "concept");
    expect(m!.conceptName).toBe("Mount Laurel interviews");
  });
  it("growth-velocity peak carries a REAL date from the trend", () => {
    const m = computeMilestones(base).find((x) => x.type === "growth_velocity");
    expect(m).toBeTruthy();
    // Largest single-window jump: 1.56M → 1.623195M = +63,195 at the last point.
    expect(m!.date).toBe("2026-06-14T00:00:00Z");
    expect(m!.value).toBe(63_195);
  });
});

describe("milestone engine — invents nothing on empty data", () => {
  it("returns no milestones when everything is null/empty", () => {
    const empty: MilestoneInput = {
      totalViews: null,
      totalEngagements: null,
      totalComments: null,
      periodViewsGained: null,
      rangeLabel: "all time",
      platforms: [
        { platform: "tiktok", label: "TikTok", views: null, viewsGained: null },
        { platform: "instagram", label: "Instagram Reels", views: null, viewsGained: null },
      ],
      topVideo: null,
      trend: [],
      topConcept: null,
    };
    expect(computeMilestones(empty)).toEqual([]);
  });
});

describe("milestone selection", () => {
  it("caps to N and sorts major → notable → minor", () => {
    const all = computeMilestones(base);
    const top = selectTopMilestones(all, 3);
    expect(top.length).toBe(3);
    expect(top[0].severity).toBe("major");
    // never returns more than requested
    expect(selectTopMilestones(all, 5).length).toBeLessThanOrEqual(5);
  });
  it("topMilestone returns the single most important", () => {
    expect(topMilestone(computeMilestones(base))!.severity).toBe("major");
    expect(topMilestone([])).toBeNull();
  });
  it("compactThreshold formats ladders cleanly", () => {
    expect(compactThreshold(1_500_000)).toBe("1.5M");
    expect(compactThreshold(2_000_000)).toBe("2M");
    expect(compactThreshold(500_000)).toBe("500K");
    expect(compactThreshold(1_000)).toBe("1K");
  });
});

// ── Source-level: Alerts badge, hero exact total, placement, safety ──────────

describe("Alerts badge design", () => {
  const badge = read("src/components/ui/notification-badge.tsx");
  const shell = read("src/components/layout/app-shell.tsx");

  it("caps at 99+ and hides at 0 (real count only)", () => {
    expect(badge).toContain('count > 99 ? "99+"');
    expect(badge).toContain("const open = count > 0;");
    expect(badge).toContain('data-open={open ? "true" : "false"}');
  });
  it("supports an inline (right-aligned) variant, not an over-icon float", () => {
    expect(badge).toContain("inline");
    expect(badge).toContain('position: "relative"');
  });
  it("is pinned to the right of the Alerts nav row with an aria-label", () => {
    expect(shell).toContain('className="ml-auto"');
    expect(shell).toContain("open alert");
    expect(shell).toContain("inline");
  });
});

describe("hero exact total", () => {
  const page = read("src/app/page.tsx");
  it("renders comma-formatted exact total beneath the shortened number", () => {
    expect(page).toContain("{formatNumber(kpis.totalViews)} total views");
  });
  it("keeps the shortened AnimatedText hero number", () => {
    expect(page).toContain("<AnimatedText text={formatCompact(kpis.totalViews)} rollOnMount />");
  });
});

describe("milestone placement", () => {
  const page = read("src/app/page.tsx");
  const studio = read("src/app/reports/reports-studio.tsx");
  const admin = read("src/app/admin/page.tsx");

  it("dashboard shows only the top 3–5 milestones", () => {
    expect(page).toContain("selectTopMilestones(");
    expect(page).toContain("<CampaignMilestones milestones={milestones} />");
    expect(page).toMatch(/selectTopMilestones\([\s\S]*?,\s*5,?\s*\)/);
  });
  it("report Executive Summary shows at most one key milestone, gated to major", () => {
    expect(studio).toContain("topMilestone(");
    expect(studio).toContain('keyMilestone?.severity === "major"');
    expect(studio).toContain("Key milestone");
  });
  it("admin exposes full milestone diagnostics", () => {
    expect(admin).toContain("Campaign milestones (diagnostics)");
    expect(admin).toContain("data.milestones");
  });
});

describe("Phase 7 safety", () => {
  const files = [
    read("src/lib/milestones.ts"),
    read("src/components/dashboard/milestones.tsx"),
    read("src/components/ui/notification-badge.tsx"),
  ];
  it("no secrets, actor IDs, vendor names, fetches, or mutations", () => {
    for (const f of files) {
      expect(f).not.toMatch(/apify/i);
      expect(f).not.toContain("actorId");
      expect(f).not.toMatch(/AIza[0-9A-Za-z_-]{10}/);
      expect(f).not.toMatch(/fetch\(/);
      expect(f).not.toMatch(/method:\s*["']POST["']/);
    }
  });
});
