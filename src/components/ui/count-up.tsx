"use client";

// Count-up number for hero/KPI values. Server-renders the FINAL formatted
// value (no layout shift, no SEO weirdness), then animates 0 → value once on
// mount with rAF. Respects prefers-reduced-motion (renders final instantly).
// Real values only — this animates presentation, never data.

import { useEffect, useRef, useState } from "react";
import { formatCompact, formatDelta, formatNumber } from "@/lib/format";

type Format = "compact" | "delta" | "number";

const FORMATTERS: Record<Format, (n: number) => string> = {
  compact: (n) => formatCompact(Math.round(n)),
  delta: (n) => formatDelta(Math.round(n)),
  number: (n) => formatNumber(Math.round(n)),
};

export function CountUp({
  value,
  format = "compact",
  durationMs = 800,
  className,
}: {
  value: number;
  format?: Format;
  durationMs?: number;
  className?: string;
}) {
  const fmt = FORMATTERS[format];
  const [display, setDisplay] = useState<string>(fmt(value));
  const animated = useRef(false);

  useEffect(() => {
    let raf = 0;
    if (animated.current) {
      // Value changed after the initial count-up (a refresh landed) — jump
      // straight to the new number; constant re-animation would be noise.
      raf = requestAnimationFrame(() => setDisplay(fmt(value)));
      return () => cancelAnimationFrame(raf);
    }
    animated.current = true;
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !Number.isFinite(value) ||
      value === 0
    ) {
      raf = requestAnimationFrame(() => setDisplay(fmt(value)));
      return () => cancelAnimationFrame(raf);
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(fmt(value * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span className={className} suppressHydrationWarning>
      {display}
    </span>
  );
}
