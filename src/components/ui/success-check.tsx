"use client";

// Success check — transitions.dev pattern #10 (skills/10-success-check.md).
// The wrapper drives fade + rotate + blur + Y-bob; the SVG <path> draws its
// stroke. Snippet covers the appear transition only (success states persist),
// so callers mount it on success and unmount when the moment passes. The
// .t-success-check classes + keyframes + reduced-motion guard live in
// globals.css verbatim (timing/easing exact).
//
// Calibration (per the snippet's "Static (recommended)" guidance): this check
// path "M13 25l6 6 13-15" measures ~28 user units, so stroke-dasharray /
// -dashoffset are set inline to 30 (rounded up) — overriding the snippet's
// placeholder 20 so the draw starts fully hidden and ends exactly on the path.

import clsx from "clsx";

export function SuccessCheck({
  show = true,
  size = 16,
  className,
}: {
  /** true → play the appear animation (data-state="in"); false → hidden. */
  show?: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={clsx("t-success-check", className)}
      data-state={show ? "in" : "out"}
      aria-hidden="true"
      style={{ color: "var(--positive)" }}
    >
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
        <path
          d="M13 25l6 6 13-15"
          stroke="currentColor"
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ strokeDasharray: 30, strokeDashoffset: 30 }}
        />
      </svg>
    </span>
  );
}
