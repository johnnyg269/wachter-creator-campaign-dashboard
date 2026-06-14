"use client";

// Icon swap — transitions.dev pattern #09 (skills/09-icon-swap.md). Two icons
// stacked in one grid cell cross-fade with blur + scale on a data-state flip.
// Pure CSS (.t-icon-swap / .t-icon in globals.css, verbatim). Decorative —
// the host button keeps its real aria-label, so the icons are aria-hidden.

import clsx from "clsx";

export function IconSwap({
  state,
  a,
  b,
  className,
}: {
  /** "a" shows the first icon, "b" the second. */
  state: "a" | "b";
  a: React.ReactNode;
  b: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={clsx("t-icon-swap", className)} data-state={state} aria-hidden="true">
      <span className="t-icon" data-icon="a">
        {a}
      </span>
      <span className="t-icon" data-icon="b">
        {b}
      </span>
    </span>
  );
}
