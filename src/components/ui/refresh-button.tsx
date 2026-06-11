"use client";

// Manual refresh trigger. Refreshes can take minutes (Apify actor runs), so
// the button shows a working state and reports the outcome inline.

import { useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { RefreshCw } from "lucide-react";

export function RefreshButton({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/refresh", { method: "POST" });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        report?: { status: string; errors: string[] };
      };
      if (!data.ok) {
        setMessage(data.error ?? "Refresh failed");
      } else if (data.report) {
        const { status, errors } = data.report;
        setMessage(
          status === "success"
            ? "Refreshed"
            : errors.length > 0
              ? `${status}: ${errors[0]}`
              : `Refresh ${status}`,
        );
      }
      router.refresh();
    } catch {
      setMessage("Refresh request failed");
    } finally {
      setBusy(false);
      setTimeout(() => setMessage(null), 8000);
    }
  }

  return (
    <div className={clsx("flex items-center gap-2", className)}>
      {message && (
        <span className="max-w-56 truncate text-[11px] text-muted" title={message}>
          {message}
        </span>
      )}
      <button
        onClick={refresh}
        disabled={busy}
        className={clsx(
          "inline-flex items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium transition-colors",
          busy ? "cursor-wait text-muted" : "hover:bg-surface-hover hover:border-border-strong",
        )}
      >
        <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        {busy ? "Refreshing…" : "Refresh now"}
      </button>
    </div>
  );
}
