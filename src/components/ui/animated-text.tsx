"use client";

// AnimatedText — a restrained "text roll" for small dynamic labels and the
// hero metrics, built on slot-text's imperative controller.
//
// Why a wrapper instead of slot-text's own React component: that component
// renders an EMPTY span on the server and fills it on mount — a flash +
// missing text for SSR'd values and screen readers. This wrapper instead:
//   • server-renders the real text (no flash, no layout shift, SR-correct)
//   • only takes over the DOM on the client when motion is allowed; once it
//     does, React stops rendering the text child so the two never fight
//   • respects prefers-reduced-motion (plain text, updates normally)
//   • degrades gracefully — any failure falls back to plain React text
//   • rolls ONLY when the text actually changes (no animation storm on load),
//     with an optional one-time settle roll on mount for the hero number
//
// aria-label always carries the final text so assistive tech reads a clean
// string, never the per-glyph slot cells.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { slotText, type SlotOptions, type SlotTextController } from "slot-text";

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function AnimatedText({
  text,
  className,
  ariaLabel,
  options,
  rollOnMount = false,
}: {
  /** The text to display. Rolls to the new value whenever this changes. */
  text: string;
  className?: string;
  ariaLabel?: string;
  /** slot-text roll options (duration, direction, stagger…). */
  options?: SlotOptions;
  /** One-time settle roll on mount — reserved for the hero metric reveal. */
  rollOnMount?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const controllerRef = useRef<SlotTextController | null>(null);
  const prevTextRef = useRef(text);
  const rafRef = useRef(0);
  // owned: once the slot-text controller owns innerHTML, React must render no
  // text child (else React's text node and the library's slot cells collide).
  const [owned, setOwned] = useState(false);

  useIsoLayoutEffect(() => {
    if (prefersReducedMotion()) return; // plain React text; updates normally
    // Phase 1: hand the child off to the controller. Flipping `owned` makes
    // React commit an empty span FIRST (it cleanly drops the text node it
    // tracks), so the build below never tears out a React-owned node.
    if (!owned) {
      setOwned(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    // Phase 2: build once, then roll only on real changes.
    if (!controllerRef.current) {
      try {
        controllerRef.current = slotText(el, text);
        prevTextRef.current = text;
        if (rollOnMount) {
          const target = text;
          rafRef.current = requestAnimationFrame(() => {
            controllerRef.current?.set(target, { skipUnchanged: false, ...options });
          });
        }
      } catch {
        // Graceful fallback: give the DOM back to React as plain text.
        controllerRef.current = null;
        setOwned(false);
      }
      return;
    }
    if (text !== prevTextRef.current) {
      prevTextRef.current = text;
      try {
        controllerRef.current.set(text, options);
      } catch {
        /* keep last-rendered text */
      }
    }
  }, [owned, text, rollOnMount, options]);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      controllerRef.current?.destroy();
      controllerRef.current = null;
    },
    [],
  );

  return (
    <span ref={ref} className={className} aria-label={ariaLabel ?? text} suppressHydrationWarning>
      {owned ? null : text}
    </span>
  );
}
