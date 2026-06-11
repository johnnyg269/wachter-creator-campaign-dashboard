"use client";

// Tracked content management: seed URL display, add video/profile, per-video
// overrides (title, episode, hidden), and manual metric snapshots.

import { useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ExternalLink, Eye, EyeOff, Plus } from "lucide-react";
import type { EpisodeGroup, Platform, PlatformProfile, Video } from "@/lib/types";
import type { Completeness } from "@/lib/completeness";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PlatformBadge } from "@/components/ui/platform";
import { StatusPill } from "@/components/ui/status";
import { TimeAgo } from "@/components/ui/time-ago";
import { VideoThumb } from "@/components/ui/video-thumb";
import { truncate } from "@/lib/format";

type AdminVideo = Video & { episodeName: string | null };

interface SeedUrl {
  platform: Platform;
  url: string;
}

async function postJson(url: string, method: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: "Request failed" };
  }
}

export function ContentManager({
  videos,
  episodes,
  profiles,
  seedVideos,
  seedProfiles,
  completeness = {},
}: {
  videos: AdminVideo[];
  episodes: EpisodeGroup[];
  profiles: PlatformProfile[];
  seedVideos: SeedUrl[];
  seedProfiles: SeedUrl[];
  completeness?: Record<string, Completeness>;
}) {
  const router = useRouter();
  const [newUrl, setNewUrl] = useState("");
  const [newEpisode, setNewEpisode] = useState("");
  const [newProfileUrl, setNewProfileUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapVideo, setSnapVideo] = useState("");
  const [snap, setSnap] = useState({ views: "", likes: "", comments: "", shares: "", saves: "" });
  const [editingTitle, setEditingTitle] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");

  async function run(action: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) {
    setBusy(true);
    setMessage(null);
    const res = await action();
    setMessage(res.ok ? okMsg : (res.error ?? "Failed"));
    if (res.ok) router.refresh();
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Seed URLs" subtitle="The campaign's starting videos and profiles (read-only)" />
        <CardBody className="grid gap-4 text-[11px] sm:grid-cols-2">
          <div>
            <div className="mb-1 font-medium text-muted">Seed videos</div>
            <ul className="space-y-1">
              {seedVideos.map((s) => (
                <li key={s.url} className="flex items-center gap-2">
                  <PlatformBadge platform={s.platform} size="sm" />
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[10px] text-muted hover:text-foreground">
                    {s.url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 font-medium text-muted">Seed profiles</div>
            <ul className="space-y-1">
              {seedProfiles.map((s) => (
                <li key={s.url} className="flex items-center gap-2">
                  <PlatformBadge platform={s.platform} size="sm" />
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[10px] text-muted hover:text-foreground">
                    {s.url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Add content" subtitle="Manually track a video or profile URL" />
        <CardBody className="space-y-3 text-xs">
          <div className="flex flex-wrap gap-2">
            <input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="Video URL (TikTok / YouTube / Instagram / Facebook)"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 outline-none focus:border-accent"
              aria-label="New video URL"
            />
            <select
              value={newEpisode}
              onChange={(e) => setNewEpisode(e.target.value)}
              className="rounded-lg border border-border bg-surface px-2 py-1.5"
              aria-label="Episode for new video"
            >
              <option value="">No episode</option>
              {episodes.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.name}
                </option>
              ))}
            </select>
            <button
              disabled={busy || !newUrl.trim()}
              onClick={() =>
                run(
                  () =>
                    postJson("/api/admin/videos", "POST", {
                      url: newUrl.trim(),
                      episodeGroupId: newEpisode || undefined,
                    }),
                  "Video added",
                ).then(() => setNewUrl(""))
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              <Plus size={12} /> Add video
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={newProfileUrl}
              onChange={(e) => setNewProfileUrl(e.target.value)}
              placeholder="Profile URL (for discovery)"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 outline-none focus:border-accent"
              aria-label="New profile URL"
            />
            <button
              disabled={busy || !newProfileUrl.trim()}
              onClick={() =>
                run(
                  () => postJson("/api/admin/profiles", "POST", { url: newProfileUrl.trim() }),
                  "Profile added",
                ).then(() => setNewProfileUrl(""))
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-3 py-1.5 font-medium hover:bg-surface-hover disabled:opacity-50"
            >
              <Plus size={12} /> Add profile
            </button>
          </div>
          {message && <p className="text-muted">{message}</p>}
          <p className="text-[10px] text-muted-strong">
            {profiles.length} profiles tracked for discovery.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={`Tracked videos (${videos.length})`}
          subtitle="Inline overrides are recorded in the audit log"
        />
        <CardBody className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-muted-strong">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Video</th>
                <th className="py-1.5 pr-3 font-medium">Episode</th>
                <th className="py-1.5 pr-3 font-medium">Status</th>
                <th className="py-1.5 pr-3 font-medium">Data</th>
                <th className="py-1.5 pr-3 font-medium">Refreshed</th>
                <th className="py-1.5 font-medium">Visible</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {videos.map((v) => (
                <tr key={v.id} className={clsx(v.hidden && "opacity-50")}>
                  <td className="max-w-80 py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <VideoThumb src={v.thumbnailUrl} platform={v.platform} className="h-10 w-7 shrink-0" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <PlatformBadge platform={v.platform} size="sm" />
                          {v.isSeed && (
                            <span className="rounded border border-border px-1 text-[9px] text-muted-strong">SEED</span>
                          )}
                          <a href={v.originalUrl} target="_blank" rel="noopener noreferrer" aria-label="Open video">
                            <ExternalLink size={11} className="text-muted-strong hover:text-foreground" />
                          </a>
                        </div>
                        {editingTitle === v.id ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              run(
                                () =>
                                  postJson(`/api/admin/videos/${v.id}`, "PATCH", {
                                    title: titleDraft,
                                    reason: "Manual title override",
                                  }),
                                "Title updated",
                              );
                              setEditingTitle(null);
                            }}
                          >
                            <input
                              value={titleDraft}
                              onChange={(e) => setTitleDraft(e.target.value)}
                              autoFocus
                              onBlur={() => setEditingTitle(null)}
                              className="mt-0.5 w-full rounded border border-accent bg-surface px-1.5 py-0.5 text-[11px] outline-none"
                              aria-label="Edit title"
                            />
                          </form>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingTitle(v.id);
                              setTitleDraft(v.title ?? "");
                            }}
                            title="Click to edit title"
                            className="mt-0.5 block max-w-full truncate text-left text-[11px] text-muted hover:text-foreground"
                          >
                            {truncate(v.title ?? v.caption ?? "(no title — click to set)", 60)}
                          </button>
                        )}
                        {v.errorMessage && (
                          <div className="mt-0.5 truncate text-[10px] text-negative" title={v.errorMessage}>
                            {v.errorMessage}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <select
                      value={v.episodeGroupId ?? ""}
                      onChange={(e) =>
                        run(
                          () =>
                            postJson(`/api/admin/videos/${v.id}`, "PATCH", {
                              episodeGroupId: e.target.value || null,
                              reason: "Episode assignment",
                            }),
                          "Episode updated",
                        )
                      }
                      className="max-w-36 rounded border border-border bg-surface px-1.5 py-1 text-[11px]"
                      aria-label="Assign episode"
                    >
                      <option value="">Unassigned</option>
                      {episodes.map((ep) => (
                        <option key={ep.id} value={ep.id}>
                          {ep.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-3">
                    <StatusPill status={v.sourceStatus} size="sm" />
                  </td>
                  <td className="py-2 pr-3">
                    {completeness[v.id] ? (
                      <span
                        className={clsx(
                          "tabular text-[11px] font-medium",
                          completeness[v.id].score >= 80
                            ? "text-positive"
                            : completeness[v.id].score >= 50
                              ? "text-warning"
                              : "text-negative",
                        )}
                        title={
                          completeness[v.id].missingFields.length > 0
                            ? `Missing: ${completeness[v.id].missingFields.join(", ")}`
                            : "All expected fields present"
                        }
                      >
                        {completeness[v.id].score}%
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-strong">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted">
                    <TimeAgo iso={v.lastRefreshedAt} />
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() =>
                        run(
                          () =>
                            postJson(`/api/admin/videos/${v.id}`, "PATCH", {
                              hidden: !v.hidden,
                              reason: v.hidden ? "Unhide video" : "Hide video",
                            }),
                          v.hidden ? "Video unhidden" : "Video hidden",
                        )
                      }
                      title={v.hidden ? "Hidden — click to show" : "Visible — click to hide"}
                      aria-label={v.hidden ? "Unhide video" : "Hide video"}
                      className="text-muted hover:text-foreground"
                    >
                      {v.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Manual metric snapshot"
          subtitle="For corrections or platforms without a live source — recorded in the audit log"
        />
        <CardBody className="flex flex-wrap items-end gap-2 text-xs">
          <div className="min-w-56">
            <label className="mb-1 block text-muted" htmlFor="snap-video">Video</label>
            <select
              id="snap-video"
              value={snapVideo}
              onChange={(e) => setSnapVideo(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-2 py-1.5"
            >
              <option value="">Select a video…</option>
              {videos.map((v) => (
                <option key={v.id} value={v.id}>
                  [{v.platform}] {truncate(v.title ?? v.caption ?? v.originalUrl, 50)}
                </option>
              ))}
            </select>
          </div>
          {(["views", "likes", "comments", "shares", "saves"] as const).map((k) => (
            <div key={k}>
              <label className="mb-1 block capitalize text-muted" htmlFor={`snap-${k}`}>{k}</label>
              <input
                id={`snap-${k}`}
                type="number"
                min={0}
                value={snap[k]}
                onChange={(e) => setSnap((s) => ({ ...s, [k]: e.target.value }))}
                className="w-24 rounded-lg border border-border bg-surface px-2 py-1.5"
                placeholder="—"
              />
            </div>
          ))}
          <button
            disabled={busy || !snapVideo}
            onClick={() =>
              run(
                () => postJson("/api/admin/snapshots", "POST", { videoId: snapVideo, ...snap }),
                "Snapshot recorded",
              ).then(() => setSnap({ views: "", likes: "", comments: "", shares: "", saves: "" }))
            }
            className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            Record snapshot
          </button>
          <p className="w-full text-[10px] text-muted-strong">
            Leave fields empty for metrics the platform doesn&apos;t expose — empty is stored as
            Unavailable, not zero.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
