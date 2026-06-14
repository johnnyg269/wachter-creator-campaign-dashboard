// Phase 6B transitions.dev patterns — fidelity to the exact source snippets,
// where each is applied, behavior/accessibility preservation, reduced-motion,
// Phase 6A non-regression, and read-only / no-secrets safety. Node test env
// (no DOM renderer) → source-level contracts, like the other component tests.
// Source of truth: github.com/Jakubantalik/transitions.dev (skills/...).

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

const css = read("src/app/globals.css");
const successCheck = read("src/components/ui/success-check.tsx");
const iconSwap = read("src/components/ui/icon-swap.tsx");
const badge = read("src/components/ui/notification-badge.tsx");
const textReveal = read("src/components/ui/text-reveal.tsx");
const clearable = read("src/components/ui/clearable-input.tsx");
const appShell = read("src/components/layout/app-shell.tsx");
const refreshBtn = read("src/components/ui/refresh-button.tsx");
const episodeMgr = read("src/app/admin/episode-manager.tsx");
const videosExplorer = read("src/app/videos/videos-explorer.tsx");
const reports = read("src/app/reports/reports-studio.tsx");
const pageHeader = read("src/components/layout/page-header.tsx");
const emptyState = read("src/components/ui/empty-state.tsx");

// ── Exact-code fidelity (timing/easing/keyframes copied verbatim) ─────────────

describe("Phase 6B :root variables copied exactly", () => {
  it("Notification badge (03): slide 260 / pop 500 / blur 2px / diagonal offsets", () => {
    expect(css).toContain("--badge-slide-dur: 260ms;");
    expect(css).toContain("--badge-pop-dur: 500ms;");
    expect(css).toContain("--badge-offset-x: -8.2px;");
    expect(css).toContain("--badge-offset-y: 12.4px;");
  });
  it("Modal (06): open 250 / close 150 / scale 0.96", () => {
    expect(css).toContain("--modal-open-dur: 250ms;");
    expect(css).toContain("--modal-close-dur: 150ms;");
    expect(css).toContain("--modal-scale: 0.96;");
  });
  it("Icon swap (09): 250ms, blur 2px, start-scale 0.25", () => {
    expect(css).toContain("--icon-swap-dur: 250ms;");
    expect(css).toContain("--icon-swap-start-scale: 0.25;");
  });
  it("Success check (10): rotate-from 80deg, y 40px, blur-from 10px, path delay 80ms", () => {
    expect(css).toContain("--check-rotate-from: 80deg;");
    expect(css).toContain("--check-y-amount: 40px;");
    expect(css).toContain("--check-blur-from: 10px;");
    expect(css).toContain("--check-path-delay: 80ms;");
  });
  it("Input clear (13): out 400ms, fly 12px, blur 2px (text-dissolve subset)", () => {
    expect(css).toContain("--clear-out-dur: 400ms;");
    expect(css).toContain("--clear-out-fly: 12px;");
    expect(css).toContain("--clear-blur: 2px;");
  });
  it("Texts reveal (18): 500ms, distance 12px, stagger 40ms, blur 3px", () => {
    expect(css).toContain("--stagger-dur: 500ms;");
    expect(css).toContain("--stagger-distance: 12px;");
    expect(css).toContain("--stagger-stagger: 40ms;");
  });
});

describe("Phase 6B CSS rules + keyframes copied exactly", () => {
  it("Success check keyframes (fade/rotate/blur/bob/draw)", () => {
    for (const k of ["t-check-fade", "t-check-rotate", "t-check-blur", "t-check-bob", "t-check-draw"]) {
      expect(css).toContain(`@keyframes ${k}`);
    }
  });
  it("Notification badge slide-in keyframe + independent dot pop", () => {
    expect(css).toContain("@keyframes t-badge-slide-in");
    expect(css).toContain(".t-badge[data-open=\"true\"]");
    expect(css).toContain(".t-badge-dot");
  });
  it("Icon swap stacks two icons in one grid cell", () => {
    expect(css).toContain("display: inline-grid;");
    expect(css).toContain("grid-area: 1 / 1;");
  });
  it("Modal scales from center", () => {
    expect(css).toContain(".t-modal {");
    expect(css).toContain("transform: scale(var(--modal-scale));");
  });
  it("Texts reveal stagger lines + decoupled exit", () => {
    expect(css).toContain(".t-stagger-line {");
    expect(css).toContain(".t-stagger.is-shown .t-stagger-line");
    expect(css).toContain(".t-stagger-line--2 { transition-delay: var(--stagger-stagger); }");
  });
});

describe("Phase 6B reduced-motion guards present", () => {
  it("each pattern is zeroed under prefers-reduced-motion: reduce", () => {
    expect(css).toContain(".t-badge, .t-badge-dot { animation: none !important; transition: none !important; }");
    expect(css).toContain(".t-modal { transition: none !important; }");
    expect(css).toContain(".t-icon-swap .t-icon { transition: none !important; }");
    expect(css).toContain(".t-success-check { animation: none !important; opacity: 1; }");
    expect(css).toContain(".t-stagger-line { transition: none !important; }");
    // input-clear mirror + button zeroed
    expect(css).toContain(".t-clear-mirror, .t-clear-mirror.is-active.is-dissolving, .t-clear-btn");
  });
});

// ── Success check ─────────────────────────────────────────────────────────────

describe("Success check", () => {
  it("uses the exact appear animation (data-state in/out, SVG path draw)", () => {
    expect(successCheck).toContain('data-state={show ? "in" : "out"}');
    expect(successCheck).toContain('aria-hidden="true"');
    expect(successCheck).toContain("strokeDasharray: 30"); // calibrated to this path
  });
  it("appears on a genuine success — admin refresh + episode CRUD", () => {
    expect(refreshBtn).toContain("SuccessCheck");
    expect(refreshBtn).toContain("setSucceeded(status === \"success\")");
    expect(episodeMgr).toContain("SuccessCheck");
    expect(episodeMgr).toContain("showFlash(");
  });
});

// ── Icon swap ─────────────────────────────────────────────────────────────────

describe("Icon swap preserves accessible labels", () => {
  it("the swap markup is decorative (aria-hidden); host keeps its label", () => {
    expect(iconSwap).toContain('aria-hidden="true"');
    expect(appShell).toContain("<IconSwap");
    expect(appShell).toContain('aria-label="Toggle navigation"'); // label kept on the button
    expect(videosExplorer).toContain("<IconSwap");
  });
  it("only state-changing icons swap (menu open/close, sort direction)", () => {
    expect(appShell).toContain('state={open ? "b" : "a"}');
    expect(videosExplorer).toContain('state={sortDir === "desc" ? "a" : "b"}');
  });
});

// ── Notification badge ────────────────────────────────────────────────────────

describe("Notification badge only for real counts", () => {
  it("opens only when count > 0 — never an invented number", () => {
    expect(badge).toContain("const open = count > 0;");
    expect(badge).toContain('data-open={open ? "true" : "false"}');
  });
  it("the open-alert count is real + resilient (0 on error, no fake data)", () => {
    const queries = read("src/lib/queries.ts");
    expect(queries).toContain("export async function getOpenAlertCount()");
    expect(queries).toContain("return 0;"); // catch fallback
    const layout = read("src/app/layout.tsx");
    expect(layout).toContain("getOpenAlertCount()");
    expect(appShell).toContain("NotificationBadge");
    expect(appShell).toContain('href === "/alerts"');
  });
});

// ── Modal ─────────────────────────────────────────────────────────────────────

describe("Modal transition without breaking focus/close", () => {
  it("the presentation overlay uses .t-modal open/closing with Esc + exit still wired", () => {
    expect(reports).toContain("t-modal");
    expect(reports).toContain("is-open");
    expect(reports).toContain("is-closing");
    expect(reports).toContain("openPresent");
    expect(reports).toContain("closePresent");
    expect(reports).toContain('if (e.key === "Escape") closePresent();');
    expect(reports).toContain('aria-label="Exit presentation"');
  });
});

// ── Input clear with dissolve ─────────────────────────────────────────────────

describe("Input clear works + preserves keyboard, no fake delay", () => {
  it("clears the value instantly (filter updates now), dissolves the old text", () => {
    expect(clearable).toContain("onClear(); // clears the controlled value now");
    expect(clearable).toContain("dissolve(old)");
    expect(clearable).toContain("is-dissolving");
  });
  it("clear button only when there is text; Escape clears; input stays native", () => {
    expect(clearable).toContain('value.length > 0 && "has-value"');
    expect(clearable).toContain('e.key === "Escape"');
    expect(clearable).toContain("<input");
  });
  it("applied to the videos search (filter behavior preserved via onChange/onClear)", () => {
    expect(videosExplorer).toContain("<ClearableInput");
    expect(videosExplorer).toContain("onChange={(e) => setSearch(e.target.value)}");
    expect(videosExplorer).toContain("onClear={() => setSearch(\"\")}");
  });
});

// ── Texts reveal ──────────────────────────────────────────────────────────────

describe("Texts reveal — sparing, reduced-motion safe, not the report canvas", () => {
  it("TextReveal adds is-shown on mount; lines carry t-stagger-line", () => {
    expect(textReveal).toContain('shown && "is-shown"');
    expect(textReveal).toContain("requestAnimationFrame");
    expect(pageHeader).toContain("t-stagger-line");
    expect(emptyState).toContain("TextReveal");
  });
  it("applied to page headers (opt-in) — videos + episodes", () => {
    expect(read("src/app/videos/page.tsx")).toContain("reveal");
    expect(read("src/app/episodes/page.tsx")).toContain("reveal");
  });
  it("NOT applied inside the report slide canvas (screenshot stability)", () => {
    // The Slide/SlideFrame render must not wrap headings in t-stagger.
    expect(reports).not.toContain("t-stagger");
  });
});

// ── Phase 6A non-regression ───────────────────────────────────────────────────

describe("Phase 6A still intact", () => {
  it("6A classes + components remain", () => {
    for (const cls of [".t-tabs-pill", ".t-dropdown", ".t-panel-slide", ".t-resize", ".t-skel", ".t-tt"]) {
      expect(css).toContain(cls);
    }
    expect(read("src/components/ui/sliding-tabs.tsx")).toContain("t-tabs-pill");
    expect(appShell).toContain("t-dropdown"); // menu dropdown still wired
    expect(videosExplorer).toContain("t-panel-slide"); // drawer panel reveal still wired
  });
  it("slot-text AnimatedText and CountUp are not replaced", () => {
    expect(read("src/components/ui/animated-text.tsx")).toContain("slotText(");
    // No transitions.dev pattern imported into AnimatedText.
    expect(read("src/components/ui/animated-text.tsx")).not.toContain("t-stagger");
  });
});

// ── Safety ────────────────────────────────────────────────────────────────────

describe("Phase 6B adds no secrets, actor IDs, or public mutations", () => {
  const files = [successCheck, iconSwap, badge, textReveal, clearable, appShell, css];
  it("no API keys or actor IDs", () => {
    for (const f of files) {
      expect(f).not.toMatch(/AIza[0-9A-Za-z_-]{10}/);
      expect(f).not.toMatch(/apify/i);
      expect(f).not.toContain("actorId");
    }
  });
  it("motion components do no fetching / POSTs", () => {
    for (const f of [successCheck, iconSwap, badge, textReveal, clearable]) {
      expect(f).not.toMatch(/fetch\(/);
      expect(f).not.toMatch(/method:\s*["']POST["']/);
    }
  });
});
