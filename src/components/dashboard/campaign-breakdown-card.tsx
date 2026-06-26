// Combined-total card: All Campaigns = Bootcamp + MTL, with per-campaign view
// totals, video counts, pending-metrics count, and a last-updated stamp. All
// figures are real last-confirmed metrics (never the estimated chart layer).

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import type { CampaignBreakdown } from "@/lib/queries";
import { formatDateTime } from "@/lib/format";

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

export function CampaignBreakdownCard({ breakdown }: { breakdown: CampaignBreakdown }) {
  const { all, bootcamp, mtl, lastUpdated } = breakdown;
  const rows = [
    { key: "all", label: "All Campaigns", t: all, accent: "text-foreground", strong: true },
    { key: "bootcamp", label: "Bootcamp", t: bootcamp, accent: "text-[#4b8dff]", strong: false },
    { key: "mtl", label: "MTL", t: mtl, accent: "text-[#34d399]", strong: false },
  ] as const;
  const pendingTotal = all.pendingMetrics;

  return (
    <Card>
      <CardHeader
        title="Combined campaign totals"
        subtitle="All Campaigns = Bootcamp + MTL. Real last-confirmed views — no estimates."
      />
      <CardBody className="space-y-3">
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface text-[10px] uppercase tracking-wide text-muted-strong">
                <th className="px-3 py-2 text-left font-medium">Campaign</th>
                <th className="px-3 py-2 text-right font-medium">Total views</th>
                <th className="px-3 py-2 text-right font-medium">Videos</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.strong ? "border-b border-border bg-surface/60" : "border-b border-border/60 last:border-0"}>
                  <td className="px-3 py-2">
                    <span className={`flex items-center gap-2 ${r.strong ? "font-semibold" : ""}`}>
                      {!r.strong && <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: r.key === "bootcamp" ? "#4b8dff" : "#34d399" }} />}
                      {r.label}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums ${r.strong ? "text-base font-semibold" : ""} ${r.accent}`}>{fmt(r.t.views)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{r.t.videos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11px] text-muted-strong">
          <span>
            {pendingTotal > 0 ? `${fmt(pendingTotal)} video${pendingTotal === 1 ? "" : "s"} pending a first reading` : "All tracked videos have metrics"}
          </span>
          {lastUpdated && <span>Updated {formatDateTime(lastUpdated)}</span>}
        </div>
      </CardBody>
    </Card>
  );
}
