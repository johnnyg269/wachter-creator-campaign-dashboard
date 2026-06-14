// transitions.dev motion patterns — fidelity to the exact source snippets,
// where each is applied, behavior preservation, reduced-motion handling, and
// the read-only / no-secrets safety invariants. The repo's test env is node
// (no DOM renderer), so — like the other component tests — these assert the
// source-level contracts. Source of truth for the CSS: the verbatim snippets
// from github.com/Jakubantalik/transitions.dev (skills/transitions-dev).

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

const css = read("src/app/globals.css");
const slidingTabs = read("src/components/ui/sliding-tabs.tsx");
const infoTooltip = read("src/components/ui/info-tooltip.tsx");
const appShell = read("src/components/layout/app-shell.tsx");
const momentum = read("src/components/charts/momentum-chart.tsx");
const reports = read("src/app/reports/reports-studio.tsx");
const videosExplorer = read("src/app/videos/videos-explorer.tsx");
const videoThumb = read("src/components/ui/video-thumb.tsx");

// ── Exact-code fidelity: the :root timing/easing matches transitions.dev ──────

describe("transitions.dev :root variables copied exactly", () => {
  it("Card resize (01): 300ms + cubic-bezier(0.22, 1, 0.36, 1)", () => {
    expect(css).toContain("--resize-dur: 300ms;");
    expect(css).toContain("--resize-ease: cubic-bezier(0.22, 1, 0.36, 1);");
  });
  it("Menu dropdown (05): open 250ms / close 150ms, pre-scale 0.97, closing 0.99", () => {
    expect(css).toContain("--dropdown-open-dur: 250ms;");
    expect(css).toContain("--dropdown-close-dur: 150ms;");
    expect(css).toContain("--dropdown-pre-scale: 0.97;");
    expect(css).toContain("--dropdown-closing-scale: 0.99;");
  });
  it("Panel reveal (07): open 400ms / close 350ms, translateY 100px, blur 2px", () => {
    expect(css).toContain("--panel-open-dur: 400ms;");
    expect(css).toContain("--panel-close-dur: 350ms;");
    expect(css).toContain("--panel-translate-y: 100px;");
    expect(css).toContain("--panel-blur: 2px;");
  });
  it("Skeleton reveal (14): pulse 1000ms, reveal 400ms, blur 2px", () => {
    expect(css).toContain("--pulse-dur: 1000ms;");
    expect(css).toContain("--reveal-dur: 400ms;");
    expect(css).toContain("--reveal-blur: 2px;");
  });
  it("Tabs sliding (16): 250ms + cubic-bezier(0.22, 1, 0.36, 1)", () => {
    expect(css).toContain("--tabs-dur: 250ms;");
    expect(css).toContain("--tabs-ease: cubic-bezier(0.22, 1, 0.36, 1);");
  });
  it("Tooltip (17): in 150ms / out 50ms, scale 0.98, delay 80ms", () => {
    expect(css).toContain("--tt-in-dur: 150ms;");
    expect(css).toContain("--tt-out-dur: 50ms;");
    expect(css).toContain("--tt-scale: 0.98;");
    expect(css).toContain("--tt-delay: 80ms;");
  });
  it("color variables are remapped to the dark theme (documented deviation)", () => {
    expect(css).toContain("--tabs-bar-bg: var(--surface);");
    expect(css).toContain("--tabs-pill-bg: var(--surface-hover);");
    expect(css).toContain("--tt-bg: var(--surface-raised);");
    // The original light-theme literals must NOT survive.
    expect(css).not.toContain("--tabs-bar-bg: #f1f1f1");
    expect(css).not.toContain("--tt-bg: #ffffff");
  });
});

describe("transitions.dev CSS rules copied exactly", () => {
  it("Tabs pill tweens transform + width", () => {
    expect(css).toContain(".t-tabs-pill {");
    expect(css).toMatch(/transform var\(--tabs-dur\) var\(--tabs-ease\)/);
    expect(css).toMatch(/width\s+var\(--tabs-dur\) var\(--tabs-ease\)/);
  });
  it("Tooltip positions above with the appear-only delay (delay only in hover/focus rule)", () => {
    expect(css).toContain("bottom: calc(100% + 8px);");
    expect(css).toContain("transition-delay: var(--tt-delay);");
  });
  it("Panel reveal cross-blurs + translates on the Y axis", () => {
    expect(css).toContain(".t-panel-slide {");
    expect(css).toContain("transform: translateY(var(--panel-translate-y));");
    expect(css).toContain("filter: blur(var(--panel-blur));");
  });
  it("Skeleton uses two stacked cross-fading layers + a pulse keyframe", () => {
    expect(css).toContain(".t-skel-skeleton");
    expect(css).toContain(".t-skel-content");
    expect(css).toContain(".t-skel.is-revealed .t-skel-content");
    expect(css).toContain("@keyframes t-skel-pulse");
  });
});

// ── Reduced motion: every pattern keeps its guard ─────────────────────────────

describe("reduced-motion guards present for every pattern", () => {
  const guards = [
    ".t-resize { transition: none !important; }",
    ".t-tabs-pill, .t-tab { transition: none !important; }",
    ".t-tt { transition: none !important; }",
    ".t-dropdown { transition: none !important; }",
    ".t-panel-slide { transition: none !important; }",
  ];
  it("each t-* pattern is zeroed under prefers-reduced-motion: reduce", () => {
    expect((css.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
    for (const g of guards) expect(css).toContain(g);
    // Skeleton guard zeroes both layers + the pulse animation.
    expect(css).toContain(".t-skel-skeleton, .t-skel-content {");
    expect(css).toContain(".t-skel-skeleton.is-pulsing > * { animation: none !important; }");
  });
});

// ── Tabs sliding: exact JS pattern + behavior preservation ────────────────────

describe("SlidingTabs implements the exact transitions.dev tabs JS", () => {
  it("writes the active tab's offsetLeft/offsetWidth onto the pill", () => {
    expect(slidingTabs).toContain("translateX(${tab.offsetLeft}px)");
    expect(slidingTabs).toContain("`${tab.offsetWidth}px`");
  });
  it("snaps without a transition on first paint / resize (suspend → reflow → restore)", () => {
    expect(slidingTabs).toContain('pill.style.transition = "none"');
    expect(slidingTabs).toContain("void pill.offsetWidth");
    expect(slidingTabs).toContain("requestAnimationFrame");
    expect(slidingTabs).toContain('addEventListener("resize"');
  });
  it("preserves accessibility + controlled state (role=tab, aria-selected, onChange)", () => {
    expect(slidingTabs).toContain('role="tablist"');
    expect(slidingTabs).toContain('role="tab"');
    expect(slidingTabs).toContain("aria-selected={active}");
    expect(slidingTabs).toContain("onChange(item.value)");
  });
  it("the chart toggles keep driving setMetric / setMode (behavior unchanged)", () => {
    expect(momentum).toContain("<SlidingTabs");
    expect(momentum).toContain("onChange={setMetric}");
    expect(momentum).toContain("onChange={setMode}");
  });
  it("the Reports segmented controls route through SlidingTabs", () => {
    expect(reports).toContain("<SlidingTabs");
  });
});

// ── Menu dropdown: applied to the custom mobile nav; native selects untouched ──

describe("Menu dropdown applied to the mobile nav (not native selects)", () => {
  it("uses the .t-dropdown open/closing state machine + origin", () => {
    expect(appShell).toContain('"t-dropdown');
    expect(appShell).toContain('data-origin="top-right"');
    expect(appShell).toContain("is-open");
    expect(appShell).toContain("is-closing");
    expect(appShell).toContain("openMenu");
    expect(appShell).toContain("closeMenu");
    expect(appShell).toContain("aria-expanded={open}");
  });
  it("native <select> filters are NOT replaced (per the brief)", () => {
    expect(reports).toContain("<select");
    expect(videosExplorer).toContain("<select");
    // The custom dropdown transition is not forced onto native selects.
    expect(reports).not.toContain("t-dropdown");
  });
});

// ── Panel reveal + Card resize: video detail drawer ───────────────────────────

describe("Panel reveal + Card resize on the video detail panel", () => {
  it("the drawer body reveals via .t-panel-slide with data-open", () => {
    expect(videosExplorer).toContain("t-panel-slide");
    expect(videosExplorer).toContain("data-open={revealed}");
    expect(videosExplorer).toContain("requestAnimationFrame(() => setRevealed(true))");
  });
  it("the drawer panel carries .t-resize for size changes", () => {
    expect(videosExplorer).toContain('"t-resize section-enter');
  });
});

// ── Tooltip: accessible markup + applied to admin diagnostics ─────────────────

describe("InfoTooltip uses the exact accessible tooltip markup", () => {
  it("trigger + adjacent role=tooltip linked by aria-describedby", () => {
    expect(infoTooltip).toContain("t-tt-wrap");
    expect(infoTooltip).toContain("t-tt-trigger");
    expect(infoTooltip).toContain('role="tooltip"');
    expect(infoTooltip).toContain("aria-describedby={id}");
  });
  it("admin diagnostics pass real tooltip content", () => {
    const admin = read("src/app/admin/page.tsx");
    expect(admin).toContain("InfoTooltip");
    expect(admin).toContain("tip=");
  });
});

// ── Skeleton reveal: video thumbnail crossfade + route loaders ────────────────

describe("Skeleton loader + reveal", () => {
  it("video thumbnail crossfades skeleton → image on real load (no fake delay)", () => {
    expect(videoThumb).toContain("t-skel");
    expect(videoThumb).toContain("t-skel-skeleton is-pulsing");
    expect(videoThumb).toContain("t-skel-content");
    expect(videoThumb).toContain("loaded && \"is-revealed\"");
    expect(videoThumb).toContain("onLoad={() => setLoaded(true)}");
    // Keeps the never-show-a-broken-image fallback.
    expect(videoThumb).toContain("setFailed(true)");
  });
  it("real Suspense loaders exist for videos / reports / episodes (no artificial delay)", () => {
    for (const p of ["src/app/videos/loading.tsx", "src/app/reports/loading.tsx", "src/app/episodes/loading.tsx"]) {
      const f = read(p);
      expect(f).toContain("skeleton");
      // No artificial delay: real Suspense boundaries, no timers.
      expect(f).not.toMatch(/setTimeout\(|setInterval\(/);
    }
  });
});

// ── Safety: no secrets / actor IDs / refresh controls leaked by new code ──────

describe("transitions add no secrets, actor IDs, or public mutations", () => {
  const newFiles = [slidingTabs, infoTooltip, appShell, videoThumb, css];
  it("no API keys or actor IDs", () => {
    for (const f of newFiles) {
      expect(f).not.toMatch(/AIza[0-9A-Za-z_-]{10}/);
      expect(f).not.toMatch(/apify/i);
      expect(f).not.toContain("actorId");
    }
  });
  it("motion components do no data fetching / mutation", () => {
    for (const f of [slidingTabs, infoTooltip]) {
      expect(f).not.toMatch(/fetch\(/);
      expect(f).not.toMatch(/method:\s*["']POST["']/);
    }
  });
});
