"use client";

// Admin-only refresh lanes. Makes explicit what each run does:
//   • Metrics refresh  — updates tracked videos only (no new-video hunting)
//   • Run discovery now — metrics + scan profiles for NEW eligible campaign videos
//   • Full refresh     — metrics + discovery + comment-detail pull
// All post to /api/refresh (admin-gated); public users can never refresh.

import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "metrics" | "discovery" | "full";

const LANES: Array<{ mode: Mode; label: string; hint: string }> = [
  { mode: "metrics", label: "Metrics refresh", hint: "Tracked videos only — no import" },
  { mode: "discovery", label: "Run discovery now", hint: "Metrics + find new campaign videos" },
  { mode: "full", label: "Full refresh", hint: "Metrics + discovery + comments" },
];

export function DiscoveryControls() {
  const router = useRouter();
  const [busy, setBusy] = useState<Mode | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function run(mode: Mode) {
    setBusy(mode);
    setMessage(null);
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, force: true }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string; report?: { status: string; newVideosDiscovered?: number; skipReason?: string } }
        | null;
      if (data?.ok && data.report) {
        const r = data.report;
        setMessage(
          r.status === "skipped"
            ? (r.skipReason ?? "Skipped")
            : `${r.status}${mode !== "metrics" ? ` · ${r.newVideosDiscovered ?? 0} new video(s) discovered` : ""}`,
        );
        router.refresh();
      } else if (data && !data.ok) {
        setMessage(data.error ?? "Refresh failed");
      } else {
        setMessage("Running in background — updating shortly…");
        setTimeout(() => router.refresh(), 30_000);
      }
    } catch {
      setMessage("Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 text-xs">
      <p className="text-muted">
        Metrics runs every 15 min (tracked videos only). Discovery scans the known campaign profiles
        for new eligible videos and runs automatically every 2 active hours — use{" "}
        <span className="font-medium">Run discovery now</span> to scan immediately.
      </p>
      <div className="flex flex-wrap gap-2">
        {LANES.map((lane) => (
          <button
            key={lane.mode}
            type="button"
            onClick={() => run(lane.mode)}
            disabled={busy !== null}
            title={lane.hint}
            className="rounded-md border border-border px-3 py-2 text-left hover:bg-surface-hover disabled:opacity-50"
          >
            <div className="font-medium">{busy === lane.mode ? "Running…" : lane.label}</div>
            <div className="text-[10px] text-muted-strong">{lane.hint}</div>
          </button>
        ))}
      </div>
      {message && <p className="text-muted-strong">{message}</p>}
    </div>
  );
}
