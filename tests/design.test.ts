// Phase 3.4 design upgrade: Inter font, momentum chart capabilities, and
// public-surface safety invariants that the redesign must not regress.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

describe("Inter font", () => {
  it("loads Inter via next/font/google and applies it globally", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain('from "next/font/google"');
    expect(layout).toContain("Inter");
    expect(layout).toContain("--font-inter");
    const css = read("src/app/globals.css");
    expect(css).toContain("--font-sans: var(--font-inter)");
    expect(css).toContain("font-family: var(--font-inter)");
  });
});

describe("momentum chart", () => {
  const chart = read("src/components/charts/momentum-chart.tsx");
  it("offers Views / Engagements / Comments toggles", () => {
    expect(chart).toContain('"views"');
    expect(chart).toContain('"engagements"');
    expect(chart).toContain('"comments"');
    expect(chart).toContain("setMetric");
  });
  it("never draws missing readings as zeros", () => {
    expect(chart).toContain("connectNulls={false}");
  });
  it("marks the latest reading", () => {
    expect(chart).toContain("ReferenceDot");
  });
  it("breaks the tooltip down by platform", () => {
    expect(chart).toContain("byPlatform");
    expect(chart).toContain("PLATFORM_LABELS");
  });
  it("uses unique timestamps on the x-axis (labels can collide)", () => {
    expect(chart).toContain('dataKey="t"');
  });
});

describe("dashboard page", () => {
  const page = read("src/app/page.tsx");
  it("offers all four time ranges", () => {
    const switcher = read("src/components/dashboard/range-switcher.tsx");
    for (const r of ['"24h"', '"7d"', '"30d"', '"all"']) expect(switcher).toContain(r);
  });
  it("handles empty and sparse chart states explicitly", () => {
    expect(page).toContain("Waiting for first refresh");
    expect(page).toContain("Tracking history is building");
  });
  it("ranks platform comparison by views with share-of-total", () => {
    expect(page).toContain("shareOfViews");
    expect(page).toContain("rank={i + 1}");
  });
  it("still renders no refresh controls (read-only public view)", () => {
    expect(page).not.toContain("RefreshButton");
    expect(page).not.toContain("/api/refresh");
  });
  it("exposes no actor IDs or vendor names in the public page", () => {
    expect(page).not.toMatch(/apify/i);
    expect(page).not.toContain("actorId");
  });
});
