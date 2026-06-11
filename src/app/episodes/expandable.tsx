"use client";

// Minimal client-side disclosure used by episode cards to expand their
// member-video lists. Children stay server-rendered and are passed through.

import { useState } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";

export function Expandable({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        <span>{label}</span>
        <ChevronDown
          size={14}
          aria-hidden
          className={clsx("shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}
