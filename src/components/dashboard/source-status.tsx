"use client";

// Data-source status strip + expandable detail panel. Honest by design: shows
// exactly what each platform is delivering and what's unavailable, so limited
// fields read as "known limitation", not "broken dashboard".

import { useState } from "react";
import clsx from "clsx";
import { Check, ChevronDown, Minus } from "lucide-react";
import type { PlatformHealth, SourceCapability } from "@/lib/queries";
import { PLATFORM_LABELS } from "@/lib/types";
import { PlatformBadge } from "@/components/ui/platform";
import { StatusPill } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/time-ago";

function CapDot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-1", on ? "text-positive" : "text-muted-strong")}>
      {on ? <Check size={11} /> : <Minus size={11} />}
      {label}
    </span>
  );
}

export function SourceStatusPanel({
  platforms,
  capabilities,
}: {
  platforms: PlatformHealth[];
  capabilities: SourceCapability[];
}) {
  const [open, setOpen] = useState(false);
  const capByPlatform = new Map(capabilities.map((c) => [c.platform, c]));

  return (
    <div className="mb-6 rounded-xl border border-border bg-surface/60">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          Data sources
        </span>
        <span className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-1">
          {platforms.map((p) => {
            const cap = capByPlatform.get(p.platform);
            return (
              <span key={p.platform} className="inline-flex items-center gap-1.5 text-[11px]">
                <PlatformBadge platform={p.platform} size="sm" />
                <span className={cap?.live ? "text-muted" : "text-warning"}>
                  {cap?.summary ?? "—"}
                </span>
              </span>
            );
          })}
        </span>
        <ChevronDown
          size={14}
          className={clsx("shrink-0 text-muted-strong transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="grid gap-3 border-t border-border px-4 py-3 sm:grid-cols-2 xl:grid-cols-4">
          {platforms.map((p) => {
            const cap = capByPlatform.get(p.platform);
            return (
              <div key={p.platform} className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <PlatformBadge platform={p.platform} size="sm" />
                  <StatusPill status={p.sourceStatus} detail={p.statusDetail} size="sm" />
                </div>
                <p className={clsx("mt-2", cap?.live ? "text-foreground/85" : "text-warning")}>
                  {cap?.summary ?? "—"}
                </p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px]">
                  <CapDot on={Boolean(p.supportsComments)} label="Comments" />
                  <CapDot on={Boolean(p.supportsDiscovery)} label="Discovery" />
                </div>
                <div className="mt-2 space-y-0.5 text-[10px] text-muted-strong">
                  <div>
                    Last refresh: <TimeAgo iso={p.lastSuccessfulRefreshAt} />
                  </div>
                  <div className="truncate">
                    {/* Public-friendly source naming — technical detail lives in /admin */}
                    Source:{" "}
                    {p.providerType === "apify"
                      ? "Automated collection"
                      : p.providerType === "youtube_api"
                        ? "Official YouTube API"
                        : p.providerType === "mock"
                          ? "Demo data"
                          : `Manual (${PLATFORM_LABELS[p.platform]})`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
