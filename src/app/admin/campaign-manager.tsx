"use client";

// Admin campaign + tracking manager: assign each video to MTL / Bootcamp /
// Unassigned, remove from tracking (soft delete, reason required + confirm), and
// restore. Supports multi-select bulk actions. Excluded videos stay visible here
// (recoverable) but are gone from every public total. Admin-gated route only.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { CampaignSlug, TrackingStatus } from "@/lib/campaigns";
import { TIER_LABELS, type RefreshTier } from "@/lib/refresh-tiers";
import type { Platform } from "@/lib/types";

export interface CampaignManagerVideo {
  id: string;
  platform: Platform;
  title: string | null;
  urlSlug: string;
  campaign: CampaignSlug | null;
  trackingStatus: TrackingStatus;
  tier: RefreshTier;
  lastRefreshedAt: string | null;
}

function relativeAge(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const CAMPAIGN_OPTIONS: Array<{ value: "mtl" | "bootcamp" | "unassigned"; label: string }> = [
  { value: "mtl", label: "MTL" },
  { value: "bootcamp", label: "Bootcamp" },
  { value: "unassigned", label: "Unassigned" },
];

export function CampaignManager({ videos }: { videos: CampaignManagerVideo[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);

  const active = useMemo(() => videos.filter((v) => v.trackingStatus !== "excluded"), [videos]);
  const excluded = useMemo(() => videos.filter((v) => v.trackingStatus === "excluded"), [videos]);
  const rows = showExcluded ? excluded : active;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function assignOne(id: string, campaign: string) {
    await act(() =>
      fetch(`/api/admin/videos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaign }),
      }),
    );
  }

  async function trackOne(id: string, action: "exclude" | "restore") {
    let reason: string | null = "restore";
    if (action === "exclude") {
      reason = window.prompt("Reason for removing this video from tracking?");
      if (reason === null) return; // cancelled
      if (!reason.trim()) { setMessage("A reason is required."); return; }
    }
    await act(() =>
      fetch(`/api/admin/videos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracking: action, reason }),
      }),
    );
  }

  async function bulk(action: "assign" | "exclude" | "restore", campaign?: string) {
    const ids = [...selected];
    if (ids.length === 0) { setMessage("Select at least one video."); return; }
    if (ids.length > 500) { setMessage("Select at most 500 videos per bulk action."); return; }
    let reason: string | undefined;
    if (action === "exclude") {
      const r = window.prompt(`Reason for removing ${ids.length} video(s) from tracking?`);
      if (r === null) return;
      if (!r.trim()) { setMessage("A reason is required."); return; }
      reason = r;
    }
    if (action === "exclude" && !window.confirm(`Remove ${ids.length} video(s) from tracking? They leave all public totals (recoverable here).`)) return;
    await act(() =>
      fetch("/api/admin/videos/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, action, campaign, reason }),
      }),
    );
    setSelected(new Set());
  }

  async function act(fn: () => Promise<Response>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; updated?: number } | null;
      if (data?.ok) {
        setMessage(typeof data.updated === "number" ? `Updated ${data.updated} video(s).` : "Saved.");
        router.refresh();
      } else {
        setMessage(data?.error ?? "Action failed");
      }
    } catch {
      setMessage("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">
          {active.length} active · {excluded.length} excluded
        </span>
        <button
          type="button"
          onClick={() => { setShowExcluded((v) => !v); setSelected(new Set()); }}
          className="rounded-lg border border-border bg-surface px-2.5 py-1 font-medium hover:bg-surface-hover"
        >
          {showExcluded ? "Show active" : `Show excluded (${excluded.length})`}
        </button>
        {message && <span className="text-foreground/80">{message}</span>}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <span className="font-medium">{selected.size} selected:</span>
          {!showExcluded && (
            <>
              <button type="button" disabled={busy} onClick={() => bulk("assign", "mtl")} className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover disabled:opacity-50">→ MTL</button>
              <button type="button" disabled={busy} onClick={() => bulk("assign", "bootcamp")} className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover disabled:opacity-50">→ Bootcamp</button>
              <button type="button" disabled={busy} onClick={() => bulk("assign", "unassigned")} className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover disabled:opacity-50">→ Unassigned</button>
              <button type="button" disabled={busy} onClick={() => bulk("exclude")} className="rounded border border-negative/50 px-2 py-0.5 text-negative hover:bg-surface-hover disabled:opacity-50">Remove from tracking</button>
            </>
          )}
          {showExcluded && (
            <button type="button" disabled={busy} onClick={() => bulk("restore")} className="rounded border border-positive/50 px-2 py-0.5 text-positive hover:bg-surface-hover disabled:opacity-50">Restore</button>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left">
          <thead className="text-[10px] uppercase tracking-wide text-muted-strong">
            <tr className="border-b border-border">
              <th className="py-1.5 pr-2 font-medium"> </th>
              <th className="py-1.5 pr-3 font-medium">Video</th>
              <th className="py-1.5 pr-3 font-medium">Platform</th>
              <th className="py-1.5 pr-3 font-medium">Campaign</th>
              <th className="py-1.5 pr-3 font-medium">Refresh tier</th>
              <th className="py-1.5 pr-3 font-medium">Tracking</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.id} className="border-b border-border/60 align-top">
                <td className="py-2 pr-2">
                  <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} aria-label={`Select ${v.title ?? v.urlSlug}`} />
                </td>
                <td className="max-w-[240px] py-2 pr-3">
                  <div className="truncate font-medium">{v.title ?? v.urlSlug}</div>
                  <div className="truncate font-mono text-[10px] text-muted-strong">{v.urlSlug}</div>
                </td>
                <td className="py-2 pr-3 capitalize">{v.platform}</td>
                <td className="py-2 pr-3">
                  {showExcluded ? (
                    <span className="text-muted">{v.campaign ?? "—"}</span>
                  ) : (
                    <select
                      value={v.campaign ?? "unassigned"}
                      disabled={busy}
                      onChange={(e) => assignOne(v.id, e.target.value)}
                      className="rounded border border-border bg-surface px-1.5 py-0.5 text-xs"
                    >
                      {CAMPAIGN_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  )}
                </td>
                <td className="py-2 pr-3">
                  <div className={v.tier === "none" ? "text-muted-strong" : v.tier === "mtl_hot" ? "text-accent" : "text-foreground"}>
                    {TIER_LABELS[v.tier]}
                  </div>
                  <div className="text-[10px] text-muted-strong">
                    {v.tier === "none" ? "removed — never refreshed" : `last ${relativeAge(v.lastRefreshedAt)}`}
                  </div>
                </td>
                <td className="py-2 pr-3">
                  {v.trackingStatus === "excluded" ? (
                    <button type="button" disabled={busy} onClick={() => trackOne(v.id, "restore")} className="rounded border border-positive/50 px-2 py-0.5 text-positive hover:bg-surface-hover disabled:opacity-50">Restore</button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => trackOne(v.id, "exclude")} className="rounded border border-negative/50 px-2 py-0.5 text-negative hover:bg-surface-hover disabled:opacity-50">Remove</button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="py-3 text-muted">{showExcluded ? "No excluded videos." : "No active videos."}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
