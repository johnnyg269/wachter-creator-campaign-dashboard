"use client";

// Video thumbnail with skeleton loading and a polished platform-branded
// fallback — a broken-image icon must never appear. Social-CDN images
// (Instagram/Facebook/TikTok) are routed through /api/thumb because those
// CDNs block browser hotlinking but allow server-side fetches.

import { useState } from "react";
import clsx from "clsx";
import type { Platform } from "@/lib/types";
import { thumbSrc } from "@/lib/thumb-proxy";
import { Clapperboard, Film } from "lucide-react";

const FALLBACK_GRADIENTS: Record<Platform, string> = {
  tiktok: "from-[#0e3b3a] to-[#11161f] text-tiktok",
  youtube: "from-[#3b1518] to-[#11161f] text-youtube",
  instagram: "from-[#3b1530] to-[#11161f] text-instagram",
  facebook: "from-[#152647] to-[#11161f] text-facebook",
};

function Fallback({ platform, className }: { platform: Platform; className?: string }) {
  return (
    <div
      className={clsx(
        "flex shrink-0 items-center justify-center rounded-lg border border-border bg-gradient-to-br",
        FALLBACK_GRADIENTS[platform],
        className ?? "h-14 w-10",
      )}
      role="img"
      aria-label={platform === "facebook" ? "Facebook Reel — thumbnail unavailable" : "Video thumbnail unavailable"}
      title={platform === "facebook" ? "Facebook Reel" : undefined}
    >
      {platform === "facebook" ? (
        <Film size={16} className="opacity-75" />
      ) : (
        <Clapperboard size={16} className="opacity-70" />
      )}
    </div>
  );
}

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
  const [failed, setFailed] = useState(false);
  const resolved = thumbSrc(src);

  if (!resolved || failed) {
    return <Fallback platform={platform} className={className} />;
  }

  return (
    <div className={clsx("relative shrink-0 overflow-hidden rounded-lg", className ?? "h-14 w-10")}>
      {/* Skeleton sits BEHIND the image: visible until pixels paint over it.
          No onLoad bookkeeping — immune to the cached-image/hydration race. */}
      <div className="absolute inset-0 animate-pulse rounded-lg border border-border bg-surface-hover" aria-hidden />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={resolved}
        alt={alt ?? "Video thumbnail"}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        ref={(el) => {
          // Catch failures that completed before hydration (onError won't refire).
          if (el && el.complete && el.naturalWidth === 0) setFailed(true);
        }}
        className="relative h-full w-full rounded-lg border border-border object-cover"
      />
    </div>
  );
}
