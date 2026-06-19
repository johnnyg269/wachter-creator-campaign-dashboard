// slot-text micro-animations: the AnimatedText safety contract and its
// targeted placements. The repo's test env is node (no DOM renderer), so —
// as with the other component tests — these assert the source-level
// guarantees that keep the animation SSR-safe, accessible, reduced-motion-
// aware, and non-destructive to React's DOM.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const at = read("src/components/ui/animated-text.tsx");

describe("AnimatedText safety contract", () => {
  it("is a client component built on slot-text's imperative controller (not the SSR-empty <SlotText>)", () => {
    expect(at.startsWith('"use client"')).toBe(true);
    expect(at).toContain('from "slot-text"');
    // Uses the imperative controller factory, never the React entrypoint whose
    // component renders empty on SSR.
    expect(at).toContain("slotText(");
    expect(at).not.toContain('"slot-text/react"');
  });
  it("server-renders the real text so there is no flash / layout shift / empty SR text", () => {
    // When not yet owned by the controller, React renders the text child.
    expect(at).toContain("{owned ? null : text}");
  });
  it("always carries an accessible label (clean string, never glyph cells)", () => {
    expect(at).toContain("aria-label={ariaLabel ?? text}");
  });
  it("respects prefers-reduced-motion — never animates, renders plain text", () => {
    expect(at).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(at).toContain("if (prefersReducedMotion()) return;");
  });
  it("hands the DOM to the controller cleanly so React and the library never fight", () => {
    // owned flips first (React drops its tracked text node) before building.
    expect(at).toContain("if (!owned) {");
    expect(at).toContain("setOwned(true)");
  });
  it("only rolls when the text actually changes — no animation storm on load", () => {
    expect(at).toContain("if (text !== prevTextRef.current)");
    expect(at).toContain("rollOnMount"); // opt-in one-time reveal for the hero only
  });
  it("degrades gracefully and tears down on unmount", () => {
    expect(at).toContain("} catch {");
    expect(at).toContain("controllerRef.current?.destroy()");
  });
  it("uses an isomorphic layout effect (no SSR useLayoutEffect warning)", () => {
    expect(at).toContain("useIsoLayoutEffect");
    expect(at).toContain('typeof window !== "undefined" ? useLayoutEffect : useEffect');
  });
});

describe("placements", () => {
  it("hero Total Views uses the one-time reveal; delta + platform-led animate on change", () => {
    const page = read("src/app/page.tsx");
    expect(page).toContain("<AnimatedText text={formatCompact(kpis.totalViews)} rollOnMount />");
    expect(page).toContain("<AnimatedText text={formatDelta(kpis.viewsGained24h)} />");
    expect(page).toContain("leads with ${topPlatformShare}% of views");
    // Hero shows operational status via the refresh note — no confidence chip.
    expect(page).toContain('<AutoRefreshNote variant="inline" />');
    expect(page).not.toContain("data.confidence.headline");
  });
  it("refresh note rolls between live / paused / delayed states", () => {
    const note = read("src/components/ui/auto-refresh-note.tsx");
    expect(note).toContain("Refresh paused overnight · resumes ${resumeHour}");
    expect(note).toContain('"Live tracking active"');
    expect(note).toContain("Next refresh in ${nextInMin}m");
    expect(note).toContain("AnimatedText");
  });
  it("chart Now label and admin health chip animate", () => {
    expect(read("src/components/charts/momentum-chart.tsx")).toContain("<AnimatedText");
    expect(read("src/app/admin/refresh-health.tsx")).toContain("<AnimatedText className={h.cls}");
  });
  it("the slot-text stylesheet is imported once at the app root", () => {
    expect(read("src/app/layout.tsx")).toContain('import "slot-text/style.css"');
  });
});

describe("restraint — animation is not sprayed everywhere", () => {
  it("the KPI band and Top Videos still use plain CountUp / static text (no roll storm)", () => {
    const page = read("src/app/page.tsx");
    // CountUp remains for the secondary KPI band numbers.
    expect(page).toContain("<CountUp");
    // Public page stays read-only — animation work introduced no refresh control.
    expect(page).not.toContain("RefreshButton");
    expect(page).not.toContain("/api/refresh");
  });
});
