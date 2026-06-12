"use client";

// Admin → Episodes: create, rename, describe, and delete the content
// concepts that group videos across platforms. Deleting never touches the
// videos themselves — members move to a chosen replacement episode or to
// Unassigned, after an explicit confirmation. Per-video assignment lives in
// the Tracked Content section's episode dropdown.

import { useRouter } from "next/navigation";
import { useState } from "react";
import clsx from "clsx";
import { Layers, Pencil, Plus, Trash2, X } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatCompact, formatNumber } from "@/lib/format";

export interface EpisodeRollup {
  id: string;
  name: string;
  description: string | null;
  videoCount: number;
  totalViews: number | null;
  totalEngagements: number | null;
  totalComments: number | null;
}

async function api(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "Request failed" };
  }
}

export function EpisodeManager({
  episodes,
  unassignedVideoCount,
}: {
  episodes: EpisodeRollup[];
  unassignedVideoCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create form
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");

  // Delete confirmation state
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [replacementId, setReplacementId] = useState<string>("");

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Something went wrong");
      return false;
    }
    router.refresh();
    return true;
  };

  const create = async () => {
    if (!newName.trim()) return;
    const ok = await run(() =>
      api("/api/admin/episodes", "POST", {
        name: newName.trim(),
        description: newDescription.trim() || null,
      }),
    );
    if (ok) {
      setNewName("");
      setNewDescription("");
    }
  };

  const saveEdit = async (id: string) => {
    const ok = await run(() =>
      api(`/api/admin/episodes/${id}`, "PATCH", {
        name: editName.trim(),
        description: editDescription.trim() || null,
      }),
    );
    if (ok) setEditingId(null);
  };

  const confirmDelete = async (id: string) => {
    const ok = await run(() =>
      api(`/api/admin/episodes/${id}`, "DELETE", {
        replacementId: replacementId || null,
      }),
    );
    if (ok) {
      setDeletingId(null);
      setReplacementId("");
    }
  };

  return (
    <Card>
      <CardHeader
        title="Episodes / content concepts"
        subtitle={`Concepts group the same content across platforms · ${formatNumber(unassignedVideoCount)} unassigned ${unassignedVideoCount === 1 ? "video" : "videos"} (assign in Tracked Content below)`}
      />
      <CardBody className="space-y-4 text-xs">
        {error && (
          <div className="rounded-lg border border-negative/40 bg-[rgba(248,113,113,0.08)] px-3 py-2 text-negative">
            {error}
          </div>
        )}

        {/* Create */}
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface px-3 py-3">
          <div className="min-w-[180px] flex-1">
            <label htmlFor="ep-new-name" className="mb-1 block text-[10px] uppercase tracking-wide text-muted-strong">
              New episode name
            </label>
            <input
              id="ep-new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={80}
              placeholder="e.g. Site walkthroughs"
              className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
          <div className="min-w-[220px] flex-[2]">
            <label htmlFor="ep-new-desc" className="mb-1 block text-[10px] uppercase tracking-wide text-muted-strong">
              Description (optional)
            </label>
            <input
              id="ep-new-desc"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              maxLength={200}
              placeholder="What this concept covers"
              className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            />
          </div>
          <button
            onClick={create}
            disabled={busy || !newName.trim()}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-[var(--accent-soft)] px-3 py-1.5 font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={12} aria-hidden /> Create episode
          </button>
        </div>

        {/* List */}
        {episodes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-strong">
            <Layers size={18} aria-hidden />
            No episodes yet — create the first concept above.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {episodes.map((e) => (
              <li key={e.id} className="py-2.5">
                {editingId === e.id ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[160px] flex-1">
                      <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-strong">
                        Name
                      </label>
                      <input
                        value={editName}
                        onChange={(ev) => setEditName(ev.target.value)}
                        maxLength={80}
                        className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs outline-none focus:border-accent"
                      />
                    </div>
                    <div className="min-w-[200px] flex-[2]">
                      <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-strong">
                        Description
                      </label>
                      <input
                        value={editDescription}
                        onChange={(ev) => setEditDescription(ev.target.value)}
                        maxLength={200}
                        className="w-full rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs outline-none focus:border-accent"
                      />
                    </div>
                    <button
                      onClick={() => saveEdit(e.id)}
                      disabled={busy || !editName.trim()}
                      className="rounded-md border border-accent/40 bg-[var(--accent-soft)] px-3 py-1.5 font-medium text-accent disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-border px-3 py-1.5 text-muted hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                ) : deletingId === e.id ? (
                  <div className="rounded-lg border border-negative/40 bg-[rgba(248,113,113,0.06)] px-3 py-2.5">
                    <div className="font-medium text-negative">
                      Delete “{e.name}”?
                      {e.videoCount > 0 && (
                        <span className="font-normal text-muted">
                          {" "}
                          {formatNumber(e.videoCount)} assigned{" "}
                          {e.videoCount === 1 ? "video" : "videos"} will be moved — the videos
                          themselves are never deleted.
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {e.videoCount > 0 && (
                        <select
                          value={replacementId}
                          onChange={(ev) => setReplacementId(ev.target.value)}
                          aria-label="Where should this episode's videos go?"
                          className="rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs outline-none focus:border-accent"
                        >
                          <option value="">Move videos to Unassigned</option>
                          {episodes
                            .filter((x) => x.id !== e.id)
                            .map((x) => (
                              <option key={x.id} value={x.id}>
                                Move videos to “{x.name}”
                              </option>
                            ))}
                        </select>
                      )}
                      <button
                        onClick={() => confirmDelete(e.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 rounded-md border border-negative/50 bg-[rgba(248,113,113,0.12)] px-3 py-1.5 font-medium text-negative disabled:opacity-50"
                      >
                        <Trash2 size={12} aria-hidden /> Delete episode
                      </button>
                      <button
                        onClick={() => {
                          setDeletingId(null);
                          setReplacementId("");
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-muted hover:text-foreground"
                      >
                        <X size={12} aria-hidden /> Keep it
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{e.name}</div>
                      {e.description && (
                        <div className="mt-0.5 truncate text-[11px] text-muted-strong">
                          {e.description}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-4 text-[11px] text-muted">
                      <span className="tabular-nums">
                        {formatNumber(e.videoCount)} {e.videoCount === 1 ? "video" : "videos"}
                      </span>
                      <span className="tabular-nums" title="Confirmed views across assigned videos">
                        {e.totalViews !== null ? `${formatCompact(e.totalViews)} views` : "Views —"}
                      </span>
                      <span className="tabular-nums" title="Likes + comments + shares">
                        {e.totalEngagements !== null
                          ? `${formatCompact(e.totalEngagements)} eng.`
                          : "Eng. —"}
                      </span>
                      <span className="tabular-nums">
                        {e.totalComments !== null
                          ? `${formatCompact(e.totalComments)} comments`
                          : "Comments —"}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        onClick={() => {
                          setEditingId(e.id);
                          setEditName(e.name);
                          setEditDescription(e.description ?? "");
                          setDeletingId(null);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-muted transition-colors hover:border-border-strong hover:text-foreground"
                        aria-label={`Rename ${e.name}`}
                      >
                        <Pencil size={11} aria-hidden /> Rename
                      </button>
                      <button
                        onClick={() => {
                          setDeletingId(e.id);
                          setReplacementId("");
                          setEditingId(null);
                        }}
                        className={clsx(
                          "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 transition-colors",
                          "border-border text-muted hover:border-negative/50 hover:text-negative",
                        )}
                        aria-label={`Delete ${e.name}`}
                      >
                        <Trash2 size={11} aria-hidden /> Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="text-[11px] text-muted-strong">
          Renaming keeps every video assigned and rolls history up under the new name. Manual
          assignments always win — automatic caption matching only ever suggests an episode for
          brand-new videos and never overwrites your choices.
        </p>
      </CardBody>
    </Card>
  );
}
