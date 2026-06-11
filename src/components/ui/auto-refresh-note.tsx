// Public replacement for the old refresh button: viewers don't trigger
// anything — data updates on a schedule and everyone sees the same saved view.

import { RefreshCw } from "lucide-react";

export function AutoRefreshNote() {
  return (
    <span
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-muted whitespace-nowrap"
      title="Campaign data refreshes automatically on a 5-minute schedule. All viewers see the same saved data."
    >
      <RefreshCw size={12} className="text-muted-strong" aria-hidden />
      Auto-refreshes every 5 minutes
    </span>
  );
}
