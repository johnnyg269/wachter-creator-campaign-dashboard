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
      interface RefreshResponse {
        ok: boolean;
        error?: string;
        report?: { status: string; errors: string[] };
      }
      let data: RefreshResponse | null = null;
      try {
        data = (await res.json()) as RefreshResponse;
      } catch {
        data = null;
      }
      if (data?.ok && data.report) {
        const { status, errors } = data.report;
        setMessage(
          status === "success"
            ? "Refreshed"
            : errors.length > 0
              ? `${status}: ${errors[0]}`
              : `Refresh ${status}`,
        );
      } else if (data && !data.ok) {
        setMessage(data.error ?? "Refresh failed");
      } else {
        // Gateway timed out the response, but long refreshes keep running
        // server-side — re-pull the page shortly instead of crying wolf.
        setMessage("Refresh running in background — updating shortly…");
        setTimeout(() => router.refresh(), 30_000);
        setTimeout(() => router.refresh(), 90_000);
      }
      router.refresh();
    } catch {
      setMessage("Refresh running in background — updating shortly…");
      setTimeout(() => router.refresh(), 30_000);
      setTimeout(() => router.refresh(), 90_000);
    } finally {
      setBusy(false);
      setTimeout(() => setMessage(null), 20_000);
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
