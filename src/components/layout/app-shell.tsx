"use client";

// App shell: fixed sidebar on desktop, collapsible top nav on mobile.

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import {
  LayoutDashboard,
  Film,
  MessageSquare,
  BarChart3,
  Layers,
  Bell,
  FileText,
  Settings,
  Menu,
  X,
} from "lucide-react";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/videos", label: "Videos", icon: Film },
  { href: "/comments", label: "Comments", icon: MessageSquare },
  { href: "/platforms", label: "Platforms", icon: BarChart3 },
  { href: "/episodes", label: "Episodes", icon: Layers },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/reports", label: "Reports", icon: FileText },
] as const;

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={clsx(
              "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-[var(--accent-soft)] text-foreground font-medium"
                : "text-muted hover:text-foreground hover:bg-surface-hover",
            )}
            aria-current={active ? "page" : undefined}
          >
            {active && (
              <span
                aria-hidden
                className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
              />
            )}
            <Icon size={16} className={active ? "text-accent" : "text-muted-strong"} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Brand block. Full horizontal logo in the expanded sidebar; the extracted
 * icon-only mark in compact/mobile states. White wordmark on transparency —
 * built for this dark background. Never stretched: explicit aspect ratios
 * from the source files (2584×358 full, 456×358 mark) + h-auto/w-auto.
 */
function Brand({ compact = false }: { compact?: boolean }) {
  if (compact) {
    return (
      <Link href="/" className="flex items-center gap-2.5" aria-label="Wachter Creator Campaign dashboard home">
        <Image
          src="/branding/wachter-creator-mark.png"
          alt=""
          width={456}
          height={358}
          priority
          className="h-7 w-auto"
        />
        <span className="text-sm font-semibold tracking-tight">Creator Campaign</span>
      </Link>
    );
  }
  return (
    <Link
      href="/"
      className="block px-3 pt-1 transition-opacity hover:opacity-85"
      aria-label="Wachter Creator Campaign dashboard home"
    >
      <Image
        src="/branding/wachter-creator-logo.png"
        alt="Wachter Creator Campaign"
        width={2584}
        height={358}
        priority
        className="h-auto w-full max-w-[188px] object-contain"
      />
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-56 shrink-0 flex-col gap-6 border-r border-border bg-surface/60 px-3 py-5 sticky top-0 h-screen">
        <Brand />
        <NavLinks />
        <div className="mt-auto px-3">
          {/* Deliberately quiet — leadership viewers shouldn't be drawn here */}
          <Link
            href="/admin"
            className="flex items-center gap-1.5 text-[10px] text-muted-strong/60 transition-colors hover:text-muted"
          >
            <Settings size={11} />
            Admin
          </Link>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="lg:hidden fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-border bg-surface/95 backdrop-blur px-4 py-3">
        <Brand compact />
        <button
          onClick={() => setOpen(!open)}
          className="rounded-lg p-2 text-muted hover:text-foreground"
          aria-label="Toggle navigation"
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>
      {open && (
        <div className="lg:hidden fixed inset-x-0 top-[57px] z-40 border-b border-border bg-surface p-3">
          <NavLinks onNavigate={() => setOpen(false)} />
          <Link
            href="/admin"
            onClick={() => setOpen(false)}
            className="mt-2 flex items-center gap-2 px-3 py-2 text-xs text-muted-strong"
          >
            <Settings size={13} />
            Admin
          </Link>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 pb-16 pt-20 lg:px-8 lg:pt-8">{children}</main>
    </div>
  );
}
