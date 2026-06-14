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
}: {
  count: number;
  className?: string;
  /** Screen-reader description, e.g. "3 open alerts". */
  srLabel?: string;
}) {
  const open = count > 0;
  return (
    <span className={clsx("t-badge", className)} data-open={open ? "true" : "false"}>
      <span
        className="t-badge-dot flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none text-white"
        style={{ background: "var(--negative)" }}
      >
        {open ? (count > 99 ? "99+" : count) : ""}
      </span>
      {open && srLabel && <span className="sr-only">{srLabel}</span>}
    </span>
  );
}
