"use client";

// ADMIN-ONLY manual refresh trigger (the /api/refresh endpoint rejects
// unauthenticated calls; public viewers rely on the scheduled auto-refresh).
// Refreshes can take minutes, so the button shows a working state, reports
// skip reasons ("refreshed recently", "already running") cleanly, and treats
// gateway-timed-out responses as background completion.

import { useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { RefreshCw, Zap } from "lucide-react";
import { SuccessCheck } from "@/components/ui/success-check";

export function RefreshButton({
  className,
  force = false,
  label,
}: {
  className?: string;
  /** Admin "Force refresh": bypasses the 3-minute freshness gate (never the lock). */
  force?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Success-check confirmation detail — shown only on a genuine success result.
  const [succeeded, setSucceeded] = useState(false);

  async function refresh() {
    if (force) {
      const ok = window.confirm(
        "Force refresh may run multiple Apify actors and use credits. Continue?",
      );
      if (!ok) return;
    }
    setBusy(true);
    setMessage(null);
    setSucceeded(false);
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      interface RefreshResponse {
        ok: boolean;
        error?: string;
        report?: { status: string; errors: string[]; skipReason?: string };
      }
      let data: RefreshResponse | null = null;
      try {
        data = (await res.json()) as RefreshResponse;
      } catch {
        data = null;
      }
      if (data?.ok && data.report) {
        const { status, errors, skipReason } = data.report;
        setSucceeded(status === "success");
        setMessage(
          status === "skipped"
            ? (skipReason ?? "Refresh skipped")
            : status === "success"
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
      setTimeout(() => {
        setMessage(null);
        setSucceeded(false);
      }, 20_000);
    }
  }

  return (
    <div className={clsx("flex items-center gap-2", className)}>
      {message && (
        <span className="inline-flex max-w-64 items-center gap-1 text-[11px] text-muted" title={message}>
          {succeeded && <SuccessCheck show size={13} />}
          <span className="truncate">{message}</span>
        </span>
      )}
      <button
        onClick={refresh}
        disabled={busy}
        className={clsx(
          "inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
          force
            ? "border-warning/40 bg-[rgba(251,191,36,0.06)] text-warning hover:bg-[rgba(251,191,36,0.12)]"
            : "border-border bg-surface-raised hover:bg-surface-hover hover:border-border-strong",
          busy && "cursor-wait opacity-60",
        )}
      >
        {force ? (
          <Zap size={13} className={busy ? "animate-pulse" : ""} />
        ) : (
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
        )}
        {busy ? "Refreshing…" : (label ?? "Refresh now")}
      </button>
    </div>
  );
}
