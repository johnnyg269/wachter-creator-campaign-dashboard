"use client";

// Notification badge — transitions.dev pattern #03 (skills/03-notification-
// badge.md). The badge slides in diagonally and pops the dot independently, so
// the trigger never moves. Only renders/animates for a REAL positive count
// (data-open flips false→true when a count appears); never an invented number.
// The .t-badge / .t-badge-dot classes + keyframe + reduced-motion guard live in
// globals.css verbatim. The host trigger must be position: relative.

import clsx from "clsx";

export function NotificationBadge({
  count,
  className,
  srLabel,
  inline = false,
}: {
  count: number;
  className?: string;
  /** Screen-reader description, e.g. "3 open alerts". */
  srLabel?: string;
  /**
   * `inline` renders the pill in normal flow (e.g. pinned to the right of a nav
   * row) instead of floating absolutely over the trigger icon — cleaner and
   * less noisy than an over-icon bubble. The pop/slide transition is preserved.
   */
  inline?: boolean;
}) {
  const open = count > 0;
  const display = count > 99 ? "99+" : String(count);
  return (
    <span
      className={clsx("t-badge", className)}
      // Override the over-icon absolute positioning for the inline variant.
      style={inline ? { position: "relative", top: "auto", right: "auto" } : undefined}
      data-open={open ? "true" : "false"}
    >
      <span
        className="t-badge-dot tabular flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold leading-none text-white"
        style={{
          // Softer, less cartoonish red than the raw negative token.
          background: "color-mix(in oklab, var(--negative) 88%, #000 12%)",
          boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
        }}
      >
        {open ? display : ""}
      </span>
      {open && srLabel && <span className="sr-only">{srLabel}</span>}
    </span>
  );
}
