"use client";

// App shell: fixed sidebar on desktop, collapsible top nav on mobile.

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
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
import { IconSwap } from "@/components/ui/icon-swap";
import { NotificationBadge } from "@/components/ui/notification-badge";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/videos", label: "Videos", icon: Film },
  { href: "/comments", label: "Comments", icon: MessageSquare },
  { href: "/platforms", label: "Platforms", icon: BarChart3 },
  { href: "/episodes", label: "Episodes", icon: Layers },
  { href: "/alerts", label: "Alerts", icon: Bell },
  { href: "/reports", label: "Reports", icon: FileText },
] as const;

function NavLinks({ onNavigate, alertCount = 0 }: { onNavigate?: () => void; alertCount?: number }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        const showBadge = href === "/alerts" && alertCount > 0;
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
            {/* Bell carries the notification badge (real open-alert count). */}
            <span className="relative inline-flex">
              <Icon size={16} className={active ? "text-accent" : "text-muted-strong"} />
              {href === "/alerts" && (
                <NotificationBadge count={alertCount} srLabel={`${alertCount} open alert${alertCount === 1 ? "" : "s"}`} />
              )}
            </span>
            {label}
            {showBadge && <span className="sr-only"> ({alertCount} open)</span>}
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

// transitions.dev Menu dropdown (#05): open adds .is-open; close swaps to
// .is-closing then unmounts after --dropdown-close-dur. Applied to the mobile
// nav menu (a genuine custom menu — native <select>s elsewhere are left as-is
// per the brief). origin "top-right": the menu grows from the hamburger.
const DROPDOWN_CLOSE_MS = 150; // matches --dropdown-close-dur in globals.css

export function AppShell({ children, alertCount = 0 }: { children: React.ReactNode; alertCount?: number }) {
  // render = in the DOM; navState drives the .t-dropdown open/closing classes.
  const [render, setRender] = useState(false);
  const [navState, setNavState] = useState<"pre" | "open" | "closing">("pre");
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openMenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setRender(true);
    // Mount in the pre-open rest state, then flip to .is-open next frame so the
    // open transition actually runs (matches the transitions.dev orchestration).
    requestAnimationFrame(() => setNavState("open"));
  };
  const closeMenu = () => {
    setNavState("closing");
    closeTimer.current = setTimeout(() => {
      setRender(false);
      setNavState("pre");
    }, DROPDOWN_CLOSE_MS);
  };
  const open = render && navState !== "closing";

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-56 shrink-0 flex-col gap-6 border-r border-border bg-surface/60 px-3 py-5 sticky top-0 h-screen">
        <Brand />
        <NavLinks alertCount={alertCount} />
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
          onClick={() => (open ? closeMenu() : openMenu())}
          className="rounded-lg p-2 text-muted hover:text-foreground"
          aria-label="Toggle navigation"
          aria-expanded={open}
          aria-controls="mobile-nav-menu"
        >
          <IconSwap state={open ? "b" : "a"} a={<Menu size={18} />} b={<X size={18} />} />
        </button>
      </div>
      {render && (
        <div
          id="mobile-nav-menu"
          data-origin="top-right"
          className={clsx(
            "t-dropdown lg:hidden fixed inset-x-0 top-[57px] z-40 border-b border-border bg-surface p-3",
            navState === "open" && "is-open",
            navState === "closing" && "is-closing",
          )}
        >
          <NavLinks onNavigate={closeMenu} alertCount={alertCount} />
          <Link
            href="/admin"
            onClick={closeMenu}
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
