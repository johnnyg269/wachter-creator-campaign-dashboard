"use client";

// Tabs sliding — transitions.dev pattern #16, adapted to React.
// Source of truth: github.com/Jakubantalik/transitions.dev
//   skills/transitions-dev/16-tabs-sliding.md
//
// The exact pattern: an absolutely-positioned pill whose `transform:
// translateX()` + `width` are written inline so CSS tweens between the
// previous and next measured tab positions. On first paint and on resize the
// values are written WITHOUT a transition (suspend → force reflow → restore)
// so the pill snaps to position before any animation can run. The .t-tabs /
// .t-tab / .t-tabs-pill classes + their prefers-reduced-motion guard live in
// globals.css verbatim from the snippet (timing/easing exact; only the pill /
// bar / text COLORS remapped to the dark theme).
//
// React adaptation (documented deviation): the original is vanilla JS reading
// from the DOM; here the active tab is a controlled prop and the click handler
// calls onChange (so existing filtering/state behavior is preserved). The
// measure-and-move logic itself is copied as-is. Reduced-motion needs no JS
// branch — the CSS guard zeroes .t-tabs-pill's transition, so a "moveTo(…,
// true)" simply snaps.

import { useCallback, useEffect, useId, useRef } from "react";
import clsx from "clsx";

export interface SlidingTabItem<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
  title?: string;
}

export function SlidingTabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className,
  tabClassName,
}: {
  items: Array<SlidingTabItem<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  tabClassName?: string;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const baseId = useId().replace(/:/g, "");

  // Exact transitions.dev moveTo(): write the active tab's offsetLeft /
  // offsetWidth onto the pill; when !animate, suspend the transition, force a
  // reflow, then restore so the pill snaps.
  const moveTo = useCallback((animate: boolean) => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const tab = bar.querySelector<HTMLElement>('[data-state="active"]');
    if (!tab) return;
    if (!animate) {
      const prev = pill.style.transition;
      pill.style.transition = "none";
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
      void pill.offsetWidth;
      pill.style.transition = prev;
    } else {
      pill.style.transform = `translateX(${tab.offsetLeft}px)`;
      pill.style.width = `${tab.offsetWidth}px`;
    }
  }, []);

  // First paint: snap without animation (rAF, as in the original).
  useEffect(() => {
    const raf = requestAnimationFrame(() => moveTo(false));
    const onResize = () => moveTo(false);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [moveTo]);

  // Active value changed → animate the pill to the new tab.
  useEffect(() => {
    moveTo(true);
  }, [value, items, moveTo]);

  return (
    <div ref={barRef} className={clsx("t-tabs", className)} role="tablist" aria-label={ariaLabel}>
      <span ref={pillRef} className="t-tabs-pill" aria-hidden="true" />
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={`${baseId}-${item.value}`}
            aria-selected={active}
            aria-label={item.ariaLabel}
            title={item.title}
            data-state={active ? "active" : "inactive"}
            onClick={() => onChange(item.value)}
            className={clsx("t-tab text-[11px] font-medium", tabClassName)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
