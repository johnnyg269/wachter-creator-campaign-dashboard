// Video thumbnail with graceful fallback. Plain <img> (not next/image)
// because scraper CDN hostnames are unpredictable and expire.

import type { Platform } from "@/lib/types";
import { PLATFORM_COLORS } from "./platform";
import clsx from "clsx";
import { Film } from "lucide-react";

export function VideoThumb({
  src,
  platform,
  alt,
  className,
}: {
  src: string | null;
  platform: Platform;
  alt?: string;
  className?: string;
}) {
  if (!src) {
    return (
      <div
        className={clsx(
          "flex items-center justify-center rounded-lg bg-surface border border-border",
          PLATFORM_COLORS[platform].text,
          className ?? "h-14 w-10",
        )}
        aria-label="No thumbnail"
      >
        <Film size={16} className="opacity-60" />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? "Video thumbnail"}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={clsx(
        // text-transparent + overflow-hidden keep failed loads (hotlink-blocked
        // CDNs) from spilling alt text; screen readers still announce alt.
        "rounded-lg object-cover bg-surface border border-border overflow-hidden text-transparent",
        className ?? "h-14 w-10",
      )}
    />
  );
}
