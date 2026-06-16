"use client";

// Admin-only review queue: records the campaign-eligibility filter EXCLUDED from
// every public total (e.g. old profile-feed imports with epoch dates). Shown for
// transparency/audit — they already do not count anywhere. "Exclude permanently"
// hides the row durably (and clears it from this queue). Never on the public app.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PLATFORM_LABELS } from "@/lib/types";
import type { QuarantinedVideoDiag } from "@/lib/queries";

const SOURCE_LABELS: Record<QuarantinedVideoDiag["source"], string> = {
  socialcrawl: "SocialCrawl",
  other: "Other",
  collector: "Collector",
};

export function ReviewQueue({ items }: { items: QuarantinedVideoDiag[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function hide(videoId: string) {
    setBusyId(videoId);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/videos/${videoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true, reason: "quarantine: out-of-campaign import" }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setMessage(data.ok ? "Excluded permanently." : (data.error ?? "Failed"));
      if (data.ok) router.refresh();
    } catch {
      setMessage("Request failed");
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="text-muted">
        No excluded records. Refreshes only update already-tracked campaign videos; out-of-campaign
        profile content is never auto-imported.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted">
        {items.length} record{items.length === 1 ? "" : "s"} excluded from all totals by the
        campaign-eligibility filter (not counted on the dashboard, reports, platform totals,
        milestones, or charts). These are not part of the campaign.
      </p>
      {message && <p className="text-muted-strong">{message}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left">
          <thead className="text-[10px] uppercase tracking-wide text-muted-strong">
            <tr className="border-b border-border">
              <th className="py-1.5 pr-3 font-medium">Content</th>
              <th className="py-1.5 pr-3 font-medium">Platform · source</th>
              <th className="py-1.5 pr-3 font-medium">Published (raw → parsed)</th>
              <th className="py-1.5 pr-3 font-medium">Reason</th>
              <th className="py-1.5 pr-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.videoId} className="border-b border-border/60 align-top">
                <td className="max-w-[260px] py-2 pr-3">
                  <div className="flex items-start gap-2">
                    {d.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- admin-only thumbnail; external CDN URL, optimization not needed
                      <img
                        src={d.thumbnailUrl}
                        alt=""
                        className="h-10 w-10 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <div className="h-10 w-10 shrink-0 rounded bg-surface-hover" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.title ?? d.urlSlug}</div>
                      <div className="truncate font-mono text-[10px] text-muted-strong">
                        {d.urlSlug}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="py-2 pr-3">
                  {PLATFORM_LABELS[d.platform]}
                  <div className="text-[10px] text-muted-strong">{SOURCE_LABELS[d.source]}</div>
                </td>
                <td className="py-2 pr-3 font-mono text-[10px] text-muted">
                  <div>raw: {d.rawPublishedAt ?? "—"}</div>
                  <div className={d.publishedAtParsed ? "text-muted" : "text-negative"}>
                    {d.publishedAtParsed ?? d.publishedAtStored ?? "—"}
                  </div>
                </td>
                <td className="py-2 pr-3 text-warning">{d.reasonLabel}</td>
                <td className="py-2 pr-3">
                  <button
                    type="button"
                    onClick={() => hide(d.videoId)}
                    disabled={busyId === d.videoId}
                    className="rounded border border-border px-2 py-1 text-[11px] hover:bg-surface-hover disabled:opacity-50"
                  >
                    {busyId === d.videoId ? "…" : "Exclude permanently"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
