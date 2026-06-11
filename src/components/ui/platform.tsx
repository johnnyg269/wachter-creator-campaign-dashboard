// Platform badges and accent colors, used across every page.

import type { Platform } from "@/lib/types";
import { PLATFORM_LABELS } from "@/lib/types";
import clsx from "clsx";

export const PLATFORM_COLORS: Record<Platform, { text: string; bg: string; dot: string }> = {
  tiktok: { text: "text-tiktok", bg: "bg-[rgba(37,244,238,0.08)]", dot: "bg-tiktok" },
  youtube: { text: "text-youtube", bg: "bg-[rgba(255,68,68,0.08)]", dot: "bg-youtube" },
  instagram: { text: "text-instagram", bg: "bg-[rgba(233,93,170,0.08)]", dot: "bg-instagram" },
  facebook: { text: "text-facebook", bg: "bg-[rgba(75,141,255,0.08)]", dot: "bg-facebook" },
};

export function PlatformBadge({
  platform,
  size = "md",
}: {
  platform: Platform;
  size?: "sm" | "md";
}) {
  const c = PLATFORM_COLORS[platform];
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
        c.bg,
        c.text,
        size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", c.dot)} />
      {PLATFORM_LABELS[platform]}
    </span>
  );
}

export function PlatformDot({ platform }: { platform: Platform }) {
  return <span className={clsx("inline-block h-2 w-2 rounded-full", PLATFORM_COLORS[platform].dot)} />;
}

/** Hex accents for charts (recharts needs literal colors). */
export const PLATFORM_HEX: Record<Platform, string> = {
  tiktok: "#25f4ee",
  youtube: "#ff4444",
  instagram: "#e95daa",
  facebook: "#4b8dff",
};
