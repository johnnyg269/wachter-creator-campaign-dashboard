"use client";

// Admin-only "Possible new content": discovered campaign videos that are after
// the campaign start but uncertain (posted before the auto-add window, or
// missing a stable id). They are NOT counted in any total until an admin adds
// them. Add to campaign → counts immediately; Dismiss → leaves the queue,
// stays excluded.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PLATFORM_LABELS } from "@/lib/types";
import type { QuarantinedVideoDiag } from "@/lib/queries";

const SOURCE_LABELS: Record<QuarantinedVideoDiag["source"], string> = {
  socialcrawl: "SocialCrawl",
  other: "Other",
  collector: "Collector",
};

export function ReviewCandidates({ items }: { items: QuarantinedVideoDiag[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function act(videoId: string, review: "promote" | "dismiss") {
    setBusy(videoId + review);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/videos/${videoId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review, reason: `discovery review: ${review}` }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setMessage(data.ok ? (review === "promote" ? "Added to campaign." : "Dismissed.") : (data.error ?? "Failed"));
      if (data.ok) router.refresh();
    } catch {
      setMessage("Request failed");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <p className="text-muted">
        No items awaiting review. New campaign videos within the discovery window are added
        automatically; only older/uncertain candidates land here.
      </p>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted">
        {items.length} candidate{items.length === 1 ? "" : "s"} discovered after the campaign start
        but not auto-added (uncertain). They do not count in any total until added.
      </p>
      {message && <p className="text-muted-strong">{message}</p>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left">
          <thead className="text-[10px] uppercase tracking-wide text-muted-strong">
            <tr className="border-b border-border">
              <th className="py-1.5 pr-3 font-medium">Content</th>
              <th className="py-1.5 pr-3 font-medium">Platform · source</th>
              <th className="py-1.5 pr-3 font-medium">Published</th>
              <th className="py-1.5 pr-3 font-medium">Why not auto-added</th>
              <th className="py-1.5 pr-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.videoId} className="border-b border-border/60 align-top">
                <td className="max-w-[260px] py-2 pr-3">
                  <div className="flex items-start gap-2">
                    {d.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- admin-only thumbnail
                      <img src={d.thumbnailUrl} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
                    ) : (
                      <div className="h-10 w-10 shrink-0 rounded bg-surface-hover" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.title ?? d.urlSlug}</div>
                      <div className="truncate font-mono text-[10px] text-muted-strong">{d.urlSlug}</div>
                    </div>
                  </div>
                </td>
                <td className="py-2 pr-3">
                  {PLATFORM_LABELS[d.platform]}
                  <div className="text-[10px] text-muted-strong">{SOURCE_LABELS[d.source]}</div>
                </td>
                <td className="py-2 pr-3 font-mono text-[10px] text-muted">
                  {d.publishedAtParsed ?? d.publishedAtStored ?? "—"}
                </td>
                <td className="py-2 pr-3 text-warning">{d.reasonLabel}</td>
                <td className="py-2 pr-3">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => act(d.videoId, "promote")}
                      disabled={busy !== null}
                      className="rounded border border-border px-2 py-1 text-[11px] hover:bg-surface-hover disabled:opacity-50"
                    >
                      {busy === d.videoId + "promote" ? "…" : "Add to campaign"}
                    </button>
                    <button
                      type="button"
                      onClick={() => act(d.videoId, "dismiss")}
                      disabled={busy !== null}
                      className="rounded border border-border px-2 py-1 text-[11px] text-muted hover:bg-surface-hover disabled:opacity-50"
                    >
                      {busy === d.videoId + "dismiss" ? "…" : "Dismiss"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
