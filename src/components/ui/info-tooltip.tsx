"use client";

// Tooltip open/close — transitions.dev pattern #17.
// Source of truth: github.com/Jakubantalik/transitions.dev
//   skills/transitions-dev/17-tooltip.md
//
// Pure CSS: the .t-tt-wrap is the hover target (so the pointer can drift onto
// the tooltip without flicker); the appear-delay lives only in the hover/focus
// rule so leaving snaps instantly. The .t-tt-wrap / .t-tt-trigger / .t-tt
// classes + their prefers-reduced-motion guard live in globals.css verbatim
// (timing/easing/transform exact; only --tt-bg/--tt-fg remapped to the dark
// theme). This component is just the accessible markup wrapper — a trigger with
// aria-describedby pointing at the role="tooltip" element that is its adjacent
// sibling (required by the `.t-tt-trigger:focus-visible + .t-tt` selector).

import { useId } from "react";
import clsx from "clsx";

export function InfoTooltip({
  label,
  children,
  className,
  triggerClassName,
  triggerLabel,
}: {
  /** Tooltip body (kept short — the snippet uses white-space: nowrap). */
  label: React.ReactNode;
  /** Trigger content (icon/text). */
  children: React.ReactNode;
  className?: string;
  triggerClassName?: string;
  /** Accessible name for the trigger button when `children` is an icon. */
  triggerLabel?: string;
}) {
  const id = `tt-${useId().replace(/:/g, "")}`;
  return (
    <span className={clsx("t-tt-wrap", className)}>
      <button
        type="button"
        className={clsx("t-tt-trigger inline-flex items-center", triggerClassName)}
        aria-describedby={id}
        aria-label={triggerLabel}
      >
        {children}
      </button>
      <span className="t-tt text-[11px] font-medium" id={id} role="tooltip">
        {label}
      </span>
    </span>
  );
}
