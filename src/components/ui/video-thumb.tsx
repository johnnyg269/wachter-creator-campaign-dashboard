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
  const [loaded, setLoaded] = useState(false);
  const resolved = thumbSrc(src);

  if (!resolved || failed) {
    return <Fallback platform={platform} className={className} />;
  }

  // Skeleton loader + reveal — transitions.dev pattern #14 (skills/14-skeleton-
  // reveal.md): two stacked layers cross-fade with a matching cross-blur when
  // real content arrives. The "data arrived" signal here is the image load.
  // We keep this app's race-hardening: a ref check covers images that finished
  // (or failed) before hydration, when onLoad/onError won't fire. No fake
  // delay — the reveal is driven by the genuine load event. The .t-skel classes
  // + reduced-motion guard live in globals.css verbatim.
  return (
    <div
      className={clsx(
        "t-skel relative shrink-0 overflow-hidden rounded-lg",
        loaded && "is-revealed",
        className ?? "h-14 w-10",
      )}
    >
      <div className="t-skel-skeleton is-pulsing" aria-hidden>
        <div className="h-full w-full rounded-lg border border-border bg-surface-hover" />
      </div>
      <div className="t-skel-content">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={resolved}
          alt={alt ?? "Video thumbnail"}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          ref={(el) => {
            if (!el || !el.complete) return;
            // Completed before hydration: onLoad/onError won't refire.
            if (el.naturalWidth === 0) setFailed(true);
            else setLoaded(true);
          }}
          className="h-full w-full rounded-lg border border-border object-cover"
        />
      </div>
    </div>
  );
}
