// Campaign Milestones — a compact, premium timeline of REAL campaign
// achievements (see lib/milestones.ts). Presentational only: it renders the
// already-computed, already-capped list. Major milestones read a touch
// stronger; platform color is a small dot accent. No oversized badges, no
// looping, no confetti. Reveal uses the shared reduced-motion-safe
// `.section-enter` class.

import clsx from "clsx";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PLATFORM_HEX } from "@/components/ui/platform";
import { formatDate } from "@/lib/format";
import type { Milestone } from "@/lib/milestones";

export function CampaignMilestones({
  milestones,
  className,
}: {
  milestones: Milestone[];
  className?: string;
}) {
  // Clean low-data state: show nothing rather than filler.
  if (milestones.length === 0) return null;

  return (
    <Card className={clsx("section-enter", className)}>
      <CardHeader
        title="Campaign milestones"
        subtitle="Key achievements from the latest refresh"
      />
      <CardBody>
        <ul className="flex flex-col gap-3.5">
          {milestones.map((m) => {
            const accent = m.platform
              ? PLATFORM_HEX[m.platform]
              : m.severity === "major"
                ? "var(--accent)"
                : "var(--muted-strong)";
            return (
              <li key={m.id} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                  style={{
                    background: accent,
                    // Subtle halo for major milestones only.
                    boxShadow:
                      m.severity === "major"
                        ? `0 0 0 3px color-mix(in oklab, ${accent} 22%, transparent)`
                        : undefined,
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={clsx(
                        "truncate text-sm",
                        m.severity === "major"
                          ? "font-semibold text-foreground"
                          : "font-medium text-foreground/90",
                      )}
                    >
                      {m.title}
                    </span>
                    {m.date && (
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-strong">
                        {formatDate(m.date)}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{m.description}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </CardBody>
    </Card>
  );
}
