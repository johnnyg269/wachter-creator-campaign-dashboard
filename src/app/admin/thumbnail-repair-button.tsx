"use client";

// Admin-only action: run the immediate, safe thumbnail repair now (SocialCrawl
// detail / YouTube Data API only — never Apify). Shows checked / repaired /
// still-missing counts and per-reason failures. Public users never see this.

import { useState } from "react";
import { useRouter } from "next/navigation";

interface RepairResult {
  missingAtStart: number;
  checked: number;
  repaired: number;
  stillMissing: number;
  creditCapReached: boolean;
  failures: Array<{ platform: string; slug: string; reason: string }>;
}

export function ThumbnailRepairButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [result, setResult] = useState<RepairResult | null>(null);

  async function run() {
    setBusy(true);
    setSummary(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/repair-thumbnails", { method: "POST" });
      const data = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string; summary?: string; result?: RepairResult }
        | null;
      if (data?.ok && data.result) {
        setSummary(data.summary ?? "Done");
        setResult(data.result);
        router.refresh();
      } else {
        setSummary(data?.error ?? "Repair failed");
      }
    } catch {
      setSummary("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-50"
      >
        {busy ? "Repairing…" : "Repair missing thumbnails now"}
      </button>
      <p className="text-[10px] text-muted-strong">
        SocialCrawl detail / YouTube API only · never Apify · respects the daily credit cap.
      </p>
      {summary && <p className="text-xs text-foreground/80">{summary}</p>}
      {result && result.failures.length > 0 && (
        <ul className="space-y-0.5 text-[10px] text-muted">
          {result.failures.slice(0, 12).map((f, i) => (
            <li key={i}>
              <span className="font-medium uppercase">{f.platform}</span> {f.slug || "—"} — {f.reason}
            </li>
          ))}
          {result.failures.length > 12 && <li>…and {result.failures.length - 12} more</li>}
        </ul>
      )}
    </div>
  );
}
