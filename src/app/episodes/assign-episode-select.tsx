"use client";

// Episode assignment dropdown used on member-video rows ("Move to…") and on
// the unassigned list ("Assign to episode…"). Posts to the episode route and
// refreshes the server-rendered page on success.

import { useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";

export interface EpisodeOption {
  id: string;
  name: string;
}

const UNASSIGN = "__unassign__";

export function AssignEpisodeSelect({
  videoId,
  currentEpisodeId,
  episodes,
  placeholder,
  ariaLabel,
  className,
}: {
  videoId: string;
  /** Episode the video currently belongs to (null when unassigned). */
  currentEpisodeId: string | null;
  episodes: EpisodeOption[];
  placeholder: string;
  ariaLabel: string;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = episodes.filter((e) => e.id !== currentEpisodeId);
  const canUnassign = currentEpisodeId !== null;

  if (targets.length === 0 && !canUnassign) {
    return (
      <span className={clsx("text-[11px] text-muted-strong", className)}>
        No episodes yet
      </span>
    );
  }

  async function assign(value: string) {
    const episodeGroupId = value === UNASSIGN ? null : value;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/episode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeGroupId }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        setError(data.error ?? "Assignment failed");
      } else {
        router.refresh();
      }
    } catch {
      setError("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={clsx("flex flex-col items-end gap-1", className)}>
      <select
        aria-label={ariaLabel}
        title={ariaLabel}
        value=""
        disabled={busy}
        onChange={(e) => {
          if (e.target.value) void assign(e.target.value);
        }}
        className={clsx(
          "max-w-40 rounded-lg border border-border bg-surface px-2 py-1.5 text-[11px] text-muted transition-colors",
          busy
            ? "cursor-wait opacity-60"
            : "hover:border-border-strong hover:text-foreground focus:border-accent focus:outline-none",
        )}
      >
        <option value="" disabled>
          {busy ? "Saving…" : placeholder}
        </option>
        {canUnassign && <option value={UNASSIGN}>Remove from episode</option>}
        {targets.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      {error && (
        <span role="alert" className="max-w-40 truncate text-[10px] text-negative" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
