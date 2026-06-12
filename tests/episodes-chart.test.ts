// Episodes concept-performance chart: stacked platform contribution,
// outlier-aware layout, honest scaling, and read-only public page.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const chart = read("src/app/episodes/concept-performance.tsx");
const page = read("src/app/episodes/page.tsx");

describe("concept performance chart", () => {
  it("stacks real per-platform totals (no best-platform-only coloring)", () => {
    expect(chart).toContain("platformValue(row, p, metric)");
    expect(chart).toContain("PLATFORM_HEX[p]");
    expect(page).toContain("perPlatform[p] ?? { views: 0, engagements: 0 }");
    // Old approach is gone from the page.
    expect(page).not.toContain("SimpleBarChart");
  });
  it("features the leading concept separately and scales the rest to THEIR max", () => {
    expect(chart).toContain("Leading concept");
    expect(chart).toContain("const [leader, ...rest]");
    expect(chart).toContain("metricTotal(rest[0], metric)");
    // Honesty note: the scale break is labeled, real totals always shown.
    expect(chart).toContain("labels show real totals");
  });
  it("labels truncate with the full name on hover — no wrapped stacks", () => {
    expect(chart).toContain("truncate");
    expect(chart).toContain("title={rowTitle(r)}");
  });
  it("tooltips carry only real computed values", () => {
    expect(chart).toContain("rowTitle");
    expect(chart).toMatch(/views\/video/);
    expect(chart).not.toMatch(/Math\.random|placeholder data|fake/i);
  });
  it("offers Views / Engagements / Views-per-video, defaulting to Views", () => {
    expect(chart).toContain('useState<Metric>("views")');
    expect(chart).toContain('"Views / video"');
  });
  it("bar fills animate via the reduced-motion-gated CSS class", () => {
    expect(chart).toContain("bar-fill");
    const css = read("src/app/globals.css");
    expect(css).toMatch(/prefers-reduced-motion: no-preference[\s\S]*bar-fill/);
  });
  it("zero-value concepts are excluded from bars (clean state), leaderboard keeps all ranked", () => {
    expect(chart).toContain("metricTotal(r, metric) > 0");
    expect(page).toContain("Concept leaderboard");
  });
  it("public Episodes page remains read-only", () => {
    expect(page).not.toContain("fetch(");
    expect(page).not.toContain("AssignEpisodeSelect");
    expect(chart).not.toContain("fetch(");
  });
  it("no raw actor payloads are serialized to the client chart", () => {
    expect(page).not.toMatch(/rawJson[^\n]*ConceptRow/);
    expect(chart).not.toContain("rawJson");
  });
});
