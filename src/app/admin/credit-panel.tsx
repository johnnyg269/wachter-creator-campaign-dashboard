// Admin SocialCrawl credit panel (Phase 2, Option B). Read-only display of the
// daily cap, today's usage + projection, balance + estimated days remaining, and
// the hot / warm / Bootcamp refresh-tier split. No secrets, no provider names
// beyond "SocialCrawl". Server component (data computed in getAdminPageData).

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TIER_LABELS } from "@/lib/refresh-tiers";
import type { CreditSummary, TierSplit } from "@/lib/credit-policy";

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "bad" }) {
  const color = tone === "bad" ? "text-negative" : tone === "warn" ? "text-warning" : "text-foreground";
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-strong">{label}</div>
      <div className={`mt-1 text-lg font-semibold tabular ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function CreditPanel({ credits, tiers }: { credits: CreditSummary; tiers: TierSplit }) {
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));
  const projTone = credits.projectedToday > credits.cap ? "bad" : credits.projectedToday > credits.cap * 0.9 ? "warn" : "ok";
  const usedTone = credits.capReached ? "bad" : credits.usedToday > credits.cap * 0.9 ? "warn" : "ok";

  return (
    <Card>
      <CardHeader
        title="SocialCrawl credits & refresh tiers"
        subtitle="Option B: hot MTL every 15 min · warm MTL every 30 min · Bootcamp daily · removed never. Scheduled refreshes stop at the daily cap and carry the rest to the next day; last-known-good is preserved."
      />
      <CardBody className="space-y-4 text-xs">
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="Credits used today"
            value={`${fmt(credits.usedToday)} / ${fmt(credits.cap)}`}
            sub={`${credits.callsToday} calls · ${credits.cachedToday} cached · ${credits.failedToday} failed`}
            tone={usedTone}
          />
          <Stat
            label="Projected today"
            value={fmt(credits.projectedToday)}
            sub={projTone === "bad" ? "above the daily cap — work will defer" : `headroom ${fmt(credits.headroomToday)} left`}
            tone={projTone}
          />
          <Stat
            label="Balance remaining"
            value={fmt(credits.remaining)}
            sub={credits.remaining === null ? "no balance reported yet" : "as last reported by SocialCrawl"}
          />
          <Stat
            label="Est. days remaining"
            value={credits.estDaysRemaining === null ? "—" : `~${credits.estDaysRemaining}d`}
            sub={credits.recentAvgPerDay === null ? "needs a few days of history" : `at ~${fmt(credits.recentAvgPerDay)}/day recent avg`}
          />
        </div>

        <div>
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Refresh-tier split (active tracked)</div>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label={TIER_LABELS.mtl_hot} value={fmt(tiers.counts.mtl_hot)} sub="every 15 min (profile sweep)" />
            <Stat label={TIER_LABELS.mtl_warm} value={fmt(tiers.counts.mtl_warm)} sub="every 30 min" />
            <Stat
              label={TIER_LABELS.bootcamp_daily}
              value={fmt(tiers.counts.bootcamp_daily)}
              sub={`~${fmt(tiers.bootcampDailyRefreshCost)} credits/day · ${fmt(tiers.bootcampPendingNow)} due now`}
            />
            <Stat label="Excluded · never" value={fmt(tiers.counts.none)} sub="removed from tracking — 0 credits" />
          </div>
        </div>

        <p className="text-[10px] text-muted-strong">
          Priority under the cap: hot MTL metrics → MTL discovery → fresh-MTL comments → warm MTL metrics →
          Bootcamp daily batch → thumbnail repair. Comment/detail pulls are limited to hot MTL (Bootcamp + cold
          off by default). Apify stays disabled.
        </p>
      </CardBody>
    </Card>
  );
}
