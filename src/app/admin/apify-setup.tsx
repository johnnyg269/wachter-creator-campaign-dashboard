"use client";

// Apify Setup: token status, per-platform actor assignment + live testing,
// pre-identified candidate actors, and Apify Store search.
// The token itself is never displayed anywhere — only its status.

import { useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Check, X, Loader2, Search, PlugZap } from "lucide-react";
import type { ActorTestResult, Platform, ProviderConfig } from "@/lib/types";
import { PLATFORM_LABELS, PLATFORMS } from "@/lib/types";
import type { PlatformHealth } from "@/lib/queries";
import type { ApifyTokenStatus } from "@/lib/apify/client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PlatformBadge } from "@/components/ui/platform";
import { TimeAgo } from "@/components/ui/time-ago";

interface Candidate {
  actorId: string;
  name: string;
  platform: Platform;
  note: string;
}

interface SeedUrl {
  platform: Platform;
  url: string;
}

interface StoreResult {
  actorId: string;
  name: string;
  username: string;
  title: string | null;
  description: string | null;
  totalRuns: number | null;
}

export function ApifySetup({
  tokenStatus,
  providerConfigs,
  healthPlatforms,
  candidates,
  seedVideos,
  seedProfiles,
  envKeys,
}: {
  tokenStatus: ApifyTokenStatus;
  providerConfigs: ProviderConfig[];
  healthPlatforms: PlatformHealth[];
  candidates: Candidate[];
  seedVideos: SeedUrl[];
  seedProfiles: SeedUrl[];
  envKeys: Record<Platform, string>;
}) {
  const router = useRouter();
  const [actorInputs, setActorInputs] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const p of PLATFORMS) {
      init[p] =
        providerConfigs.find((c) => c.platform === p)?.actorId ??
        healthPlatforms.find((h) => h.platform === p)?.actorId ??
        "";
    }
    return init;
  });
  const [overrideInputs, setOverrideInputs] = useState<Record<string, string>>({});
  const [showOverride, setShowOverride] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, "save" | "test" | null>>({});
  const [testResults, setTestResults] = useState<Record<string, ActorTestResult | null>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [storeResults, setStoreResults] = useState<StoreResult[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  function setBusyFor(p: Platform, v: "save" | "test" | null) {
    setBusy((b) => ({ ...b, [p]: v }));
  }

  async function saveActor(platform: Platform) {
    const actorId = actorInputs[platform]?.trim();
    if (!actorId) return;
    setBusyFor(platform, "save");
    setErrors((e) => ({ ...e, [platform]: null }));
    try {
      const res = await fetch("/api/admin/actor-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          actorId,
          inputOverride: overrideInputs[platform]?.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) setErrors((e) => ({ ...e, [platform]: data.error ?? "Save failed" }));
      else router.refresh();
    } catch {
      setErrors((e) => ({ ...e, [platform]: "Request failed" }));
    } finally {
      setBusyFor(platform, null);
    }
  }

  async function runTest(platform: Platform) {
    const actorId = actorInputs[platform]?.trim();
    if (!actorId) return;
    setBusyFor(platform, "test");
    setErrors((e) => ({ ...e, [platform]: null }));
    setTestResults((r) => ({ ...r, [platform]: null }));
    try {
      const res = await fetch("/api/admin/actor-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          actorId,
          inputOverride: overrideInputs[platform]?.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string; result?: ActorTestResult };
      if (!data.ok || !data.result) {
        setErrors((e) => ({ ...e, [platform]: data.error ?? "Test failed" }));
      } else {
        setTestResults((r) => ({ ...r, [platform]: data.result ?? null }));
        router.refresh();
      }
    } catch {
      setErrors((e) => ({ ...e, [platform]: "Test request failed (it may have timed out)" }));
    } finally {
      setBusyFor(platform, null);
    }
  }

  async function searchStore() {
    if (!query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await fetch(`/api/admin/actor-search?q=${encodeURIComponent(query.trim())}`);
      const data = (await res.json()) as { ok: boolean; error?: string; results?: StoreResult[] };
      if (!data.ok) setSearchError(data.error ?? "Search failed");
      else setStoreResults(data.results ?? []);
    } catch {
      setSearchError("Search request failed");
    } finally {
      setSearching(false);
    }
  }

  function CapBadge({ on, label }: { on: boolean; label: string }) {
    return (
      <span
        className={clsx(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
          on ? "border-positive/40 text-positive" : "border-border text-muted-strong",
        )}
      >
        {on ? <Check size={10} /> : <X size={10} />}
        {label}
      </span>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Apify Setup"
          subtitle="Token-first: add APIFY_TOKEN, then assign and test an actor per platform"
        />
        <CardBody>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-xs">
            <PlugZap size={14} className={tokenStatus.valid ? "text-positive" : "text-warning"} />
            {!tokenStatus.configured ? (
              <span className="text-warning">
                <strong>APIFY_TOKEN missing.</strong> Add it to <code>.env.local</code> locally and
                Vercel → Settings → Environment Variables in production. Get one at
                console.apify.com → Settings → API &amp; Integrations.
              </span>
            ) : tokenStatus.valid ? (
              <span className="text-positive">
                Apify token connected{tokenStatus.username ? <> — account <strong>{tokenStatus.username}</strong></> : null}.
                The token is never displayed or sent to the browser.
              </span>
            ) : (
              <span className="text-negative">
                Apify token configured but <strong>invalid</strong>
                {tokenStatus.error ? ` (${tokenStatus.error})` : ""}. Rotate it in the Apify console
                and update the env var.
              </span>
            )}
          </div>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {PLATFORMS.map((platform) => {
          const config = providerConfigs.find((c) => c.platform === platform) ?? null;
          const health = healthPlatforms.find((h) => h.platform === platform);
          const liveTest = testResults[platform] ?? config?.lastTestResult ?? null;
          const seedVideo = seedVideos.find((s) => s.platform === platform)?.url;
          const seedProfile = seedProfiles.find((s) => s.platform === platform)?.url;
          const testUrl = platform === "youtube" ? seedProfile : seedVideo;
          const isBusy = busy[platform];
          return (
            <Card key={platform} className="flex flex-col">
              <CardHeader
                title={<PlatformBadge platform={platform} />}
                action={
                  <span className="text-[10px] text-muted-strong">
                    {config?.status ?? "untested"}
                    {config?.lastTestedAt && (
                      <>
                        {" · tested "}
                        <TimeAgo iso={config.lastTestedAt} />
                      </>
                    )}
                  </span>
                }
              />
              <CardBody className="flex flex-1 flex-col gap-3 text-xs">
                {platform === "youtube" && (
                  <p className="text-muted-strong">
                    YouTube prefers the official API when <code>YOUTUBE_API_KEY</code> is set; the
                    Apify actor below is the fallback. Provider now:{" "}
                    <strong>{health?.providerType ?? "—"}</strong>
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  <CapBadge on={Boolean(config?.supportsMetadata)} label="Metadata" />
                  <CapBadge on={Boolean(config?.supportsMetrics)} label="Metrics" />
                  <CapBadge on={Boolean(config?.supportsComments)} label="Comments" />
                  <CapBadge on={Boolean(config?.supportsDiscovery)} label="Discovery" />
                </div>

                <div>
                  <label className="mb-1 block text-muted" htmlFor={`actor-${platform}`}>
                    Actor ID <span className="text-muted-strong">(username~actor-name or ID — e.g. GdWCkxBtKWOsKjdch)</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      id={`actor-${platform}`}
                      value={actorInputs[platform] ?? ""}
                      onChange={(e) => setActorInputs((a) => ({ ...a, [platform]: e.target.value }))}
                      placeholder="username~actor-name"
                      className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-[11px] outline-none focus:border-accent"
                    />
                    <button
                      onClick={() => saveActor(platform)}
                      disabled={isBusy !== null && isBusy !== undefined || !actorInputs[platform]?.trim()}
                      className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 font-medium hover:bg-surface-hover disabled:opacity-50"
                    >
                      {isBusy === "save" ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => runTest(platform)}
                      disabled={Boolean(isBusy) || !actorInputs[platform]?.trim()}
                      className="rounded-lg bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50"
                    >
                      {isBusy === "test" ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Loader2 size={12} className="animate-spin" /> Testing…
                        </span>
                      ) : (
                        "Test actor"
                      )}
                    </button>
                  </div>
                  {isBusy === "test" && (
                    <p className="mt-1 text-muted-strong">
                      Running the actor on Apify — this can take 1–3 minutes.
                    </p>
                  )}
                </div>

                <p className="text-muted-strong">
                  Test target: <span className="break-all font-mono text-[10px]">{testUrl}</span>
                </p>

                <button
                  onClick={() => setShowOverride((s) => ({ ...s, [platform]: !s[platform] }))}
                  className="self-start text-muted underline-offset-2 hover:underline"
                >
                  {showOverride[platform] ? "Hide input override" : "Input override (advanced)"}
                </button>
                {showOverride[platform] && (
                  <textarea
                    value={overrideInputs[platform] ?? ""}
                    onChange={(e) => setOverrideInputs((o) => ({ ...o, [platform]: e.target.value }))}
                    placeholder='Full actor input JSON, used verbatim, e.g. {"startUrls":[{"url":"…"}]}'
                    rows={3}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[10px] outline-none focus:border-accent"
                  />
                )}

                {errors[platform] && <p className="text-negative">{errors[platform]}</p>}

                {liveTest && (
                  <div
                    className={clsx(
                      "rounded-lg border px-3 py-2",
                      liveTest.ok ? "border-positive/30 bg-[rgba(52,211,153,0.05)]" : "border-negative/30 bg-[rgba(248,113,113,0.05)]",
                    )}
                  >
                    <div className="flex items-center gap-2 font-medium">
                      {liveTest.ok ? (
                        <Check size={12} className="text-positive" />
                      ) : (
                        <X size={12} className="text-negative" />
                      )}
                      {liveTest.ok ? "Actor test passed" : "Actor test failed"}
                      <span className="ml-auto font-normal text-muted-strong">
                        {liveTest.itemCount} item(s)
                        {liveTest.durationMs ? ` · ${(liveTest.durationMs / 1000).toFixed(0)}s` : ""}
                      </span>
                    </div>
                    <p className="mt-1 text-muted">Input: {liveTest.inputDescription}</p>
                    {liveTest.error && <p className="mt-1 text-negative">{liveTest.error}</p>}
                    {liveTest.normalizedPreview && (
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
                        <span className="text-muted-strong">views</span>
                        <span className="tabular">{liveTest.normalizedPreview.views ?? "Unavailable"}</span>
                        <span className="text-muted-strong">likes</span>
                        <span className="tabular">{liveTest.normalizedPreview.likes ?? "Unavailable"}</span>
                        <span className="text-muted-strong">comments</span>
                        <span className="tabular">{liveTest.normalizedPreview.comments ?? "Unavailable"}</span>
                        <span className="text-muted-strong">shares</span>
                        <span className="tabular">{liveTest.normalizedPreview.shares ?? "Unavailable"}</span>
                        <span className="text-muted-strong">title</span>
                        <span className="truncate" title={liveTest.normalizedPreview.title ?? undefined}>
                          {liveTest.normalizedPreview.title ?? "—"}
                        </span>
                        <span className="text-muted-strong">published</span>
                        <span>{liveTest.normalizedPreview.publishedAt?.slice(0, 16).replace("T", " ") ?? "—"}</span>
                      </div>
                    )}
                    {liveTest.detectedFields.length > 0 && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-muted-strong">
                          {liveTest.detectedFields.length} detected fields
                        </summary>
                        <p className="mt-1 break-all font-mono text-[10px] text-muted">
                          {liveTest.detectedFields.join(", ")}
                        </p>
                      </details>
                    )}
                    {liveTest.inputUsed != null && (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-muted-strong">input JSON used</summary>
                        <pre className="mt-1 overflow-x-auto rounded bg-background p-2 font-mono text-[10px] text-muted">
                          {JSON.stringify(liveTest.inputUsed, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                )}

                <p className="mt-auto text-[10px] text-muted-strong">
                  Production env var: <code>{envKeys[platform]}</code> (runtime config saved here
                  takes precedence)
                </p>
              </CardBody>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader
          title="Candidate actors"
          subtitle="Pre-identified for this campaign — verified via the Apify API"
        />
        <CardBody className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-strong">
              <tr>
                <th className="py-1.5 pr-4 font-medium">Actor</th>
                <th className="py-1.5 pr-4 font-medium">ID</th>
                <th className="py-1.5 pr-4 font-medium">Platform</th>
                <th className="py-1.5 pr-4 font-medium">Note</th>
                <th className="py-1.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {candidates.map((c) => (
                <tr key={c.actorId}>
                  <td className="py-2 pr-4 whitespace-nowrap">{c.name}</td>
                  <td className="py-2 pr-4 font-mono text-[10px]">{c.actorId}</td>
                  <td className="py-2 pr-4">
                    <PlatformBadge platform={c.platform} size="sm" />
                  </td>
                  <td className="max-w-72 py-2 pr-4 text-muted">{c.note}</td>
                  <td className="py-2 whitespace-nowrap">
                    <button
                      onClick={() => setActorInputs((a) => ({ ...a, [c.platform]: c.actorId }))}
                      className="rounded-lg border border-border bg-surface-raised px-2.5 py-1 text-[11px] hover:bg-surface-hover"
                    >
                      Use for {PLATFORM_LABELS[c.platform]}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Find an actor" subtitle="Search the public Apify Store" />
        <CardBody className="space-y-3">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && searchStore()}
              placeholder='e.g. "tiktok scraper", "instagram reels"'
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs outline-none focus:border-accent"
              aria-label="Search Apify Store"
            />
            <button
              onClick={searchStore}
              disabled={searching || !query.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs font-medium hover:bg-surface-hover disabled:opacity-50"
            >
              {searching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
              Search
            </button>
          </div>
          {searchError && <p className="text-xs text-negative">{searchError}</p>}
          {storeResults && storeResults.length === 0 && (
            <p className="text-xs text-muted">No results.</p>
          )}
          {storeResults && storeResults.length > 0 && (
            <ul className="divide-y divide-border text-xs">
              {storeResults.map((r) => (
                <li key={r.actorId} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-medium">
                    {r.username}/{r.name}
                  </span>
                  <span className="font-mono text-[10px] text-muted-strong">{r.actorId}</span>
                  {r.totalRuns !== null && (
                    <span className="text-muted-strong">{Intl.NumberFormat("en-US", { notation: "compact" }).format(r.totalRuns)} runs</span>
                  )}
                  <span className="w-full text-muted">{r.description}</span>
                  <span className="flex gap-1.5">
                    {PLATFORMS.map((p) => (
                      <button
                        key={p}
                        onClick={() => setActorInputs((a) => ({ ...a, [p]: r.actorId }))}
                        className="rounded border border-border px-2 py-0.5 text-[10px] text-muted hover:text-foreground"
                      >
                        → {PLATFORM_LABELS[p]}
                      </button>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-muted-strong">
            Selecting a result only fills the actor field above — test it before relying on it.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
