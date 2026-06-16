// /admin — internal control room: campaign settings, Apify setup, tracked
// content management, refresh logs, and the override audit trail.

import { isAdminAuthenticated, adminPasswordConfigured } from "@/lib/auth";
import { getAdminPageData } from "@/lib/queries";
import { CANDIDATE_ACTORS, SEED_PROFILES, SEED_VIDEOS, actorEnvKey } from "@/lib/config";
import { PageHeader } from "@/components/layout/page-header";
import { DataNotice } from "@/components/layout/data-notice";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { RefreshButton } from "@/components/ui/refresh-button";
import { TimeAgo } from "@/components/ui/time-ago";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { Info } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { LoginForm } from "./login-form";
import { ApifySetup } from "./apify-setup";
import { CampaignSettings } from "./campaign-settings";
import { ContentManager } from "./content-manager";
import { RefreshHealthPanel } from "./refresh-health";
import { EpisodeManager } from "./episode-manager";
import { ReviewQueue } from "./review-queue";

export const dynamic = "force-dynamic";

const SECTIONS = [
  { id: "readiness", label: "Production Readiness" },
  { id: "automation", label: "Refresh Health" },
  { id: "providers", label: "Metrics Providers" },
  { id: "youtube", label: "YouTube Provider" },
  { id: "facebook", label: "Facebook Views" },
  { id: "review", label: "Review Queue" },
  { id: "milestones", label: "Milestones" },
  { id: "episodes", label: "Episodes" },
  { id: "campaign", label: "Campaign" },
  { id: "apify", label: "Apify Setup" },
  { id: "content", label: "Tracked Content" },
  { id: "attempts", label: "Collection Attempts" },
  { id: "logs", label: "Refresh Logs" },
  { id: "overrides", label: "Override Log" },
];

function ReadinessRow({
  ok,
  label,
  detail,
  warnOnly,
  tip,
}: {
  ok: boolean;
  label: string;
  detail: string;
  /** Render a soft warning instead of a hard red when not ok. */
  warnOnly?: boolean;
  /** Optional diagnostic tooltip (transitions.dev tooltip pattern). */
  tip?: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5">
      <span
        className={
          ok
            ? "mt-0.5 h-2 w-2 shrink-0 rounded-full bg-positive"
            : warnOnly
              ? "mt-0.5 h-2 w-2 shrink-0 rounded-full bg-warning"
              : "mt-0.5 h-2 w-2 shrink-0 rounded-full bg-negative"
        }
      />
      <div className="min-w-0 text-xs">
        <div className="flex items-center gap-1.5 font-medium">
          {label}
          {tip && (
            <InfoTooltip label={tip} triggerLabel={`About: ${label}`} triggerClassName="text-muted-strong hover:text-foreground">
              <Info size={12} />
            </InfoTooltip>
          )}
        </div>
        <div className="mt-0.5 text-[11px] text-muted">{detail}</div>
      </div>
    </div>
  );
}

export default async function AdminPage() {
  const authed = await isAdminAuthenticated();
  if (!authed) {
    return (
      <div className="mx-auto mt-24 max-w-sm">
        <LoginForm />
      </div>
    );
  }

  const data = await getAdminPageData();
  const passwordSet = adminPasswordConfigured();

  // Data-source readiness reflects the PROVIDER model, not just Apify actor IDs.
  // TikTok/Instagram/Facebook use Apify; YouTube prefers the official Data API
  // (no Apify actor needed) and only falls back to Apify when no key is set.
  const apifyPlatforms = ["tiktok", "instagram", "facebook"] as const;
  const apifyReady = apifyPlatforms.every((p) => Boolean(data.readiness.actorIds[p]));
  const ytApiPrimary = data.youtubeProvider.mode === "youtube_api";
  const ytApifyFallback = Boolean(data.readiness.actorIds.youtube);
  const youtubeReady = ytApiPrimary || ytApifyFallback; // healthy with either
  const youtubeSourceLabel = ytApiPrimary
    ? ytApifyFallback
      ? "API ✓, fallback available"
      : "API ✓"
    : ytApifyFallback
      ? "Apify ✓ (fallback)"
      : "not configured";
  const dataSourcesReady = apifyReady && youtubeReady;
  const dataSourcesDetail = [
    `TikTok: ${data.readiness.actorIds.tiktok ? "Apify ✓" : "Apify —"}`,
    `Instagram: ${data.readiness.actorIds.instagram ? "Apify ✓" : "Apify —"}`,
    `Facebook: ${data.readiness.actorIds.facebook ? "Apify ✓" : "Apify —"}`,
    `YouTube: ${youtubeSourceLabel}`,
  ].join("  ·  ");

  return (
    <div className="mx-auto max-w-6xl">
      <DataNotice health={data.health} />
      {!passwordSet && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-[rgba(251,191,36,0.08)] px-4 py-2.5 text-xs text-warning">
          <strong>ADMIN_PASSWORD is not set</strong> — this page is open. Set it in .env.local /
          Vercel env vars before sharing the deployment.
        </div>
      )}
      <PageHeader
        title="Admin"
        subtitle="Internal controls — tracked links, refreshes, overrides, and Apify setup"
        actions={
          <>
            <RefreshButton />
            <RefreshButton force label="Force refresh" />
          </>
        }
      />

      <nav className="mb-6 flex flex-wrap gap-2 text-xs">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-border bg-surface px-3 py-1 text-muted hover:text-foreground hover:border-border-strong"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <div className="space-y-10">
        <section id="readiness">
          <Card>
            <CardHeader
              title="Production readiness"
              subtitle="Everything the deployed version needs before sharing the URL"
            />
            <CardBody className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              <ReadinessRow
                ok={data.readiness.databaseConnected}
                label={`Database: ${data.readiness.databaseConnected ? "Supabase/Postgres connected" : "not connected"}`}
                detail={
                  data.readiness.databaseConnected
                    ? data.health.store.detail
                    : `Storage mode: ${data.health.store.detail}. Set DATABASE_URL for durable history before sharing broadly.`
                }
              />
              <ReadinessRow
                ok={Boolean(data.tokenStatus.configured && data.tokenStatus.valid)}
                label={`Apify token: ${
                  !data.tokenStatus.configured ? "missing" : data.tokenStatus.valid ? "connected" : "invalid"
                }`}
                detail={
                  data.tokenStatus.valid
                    ? `Account ${data.tokenStatus.username ?? "verified"} — token never displayed`
                    : "Set APIFY_TOKEN in env vars"
                }
              />
              <ReadinessRow
                ok={dataSourcesReady}
                warnOnly
                label={`Data sources: ${dataSourcesReady ? "all platforms connected" : "needs attention"}`}
                detail={dataSourcesDetail}
                tip="TikTok / Instagram / Facebook use Apify. YouTube prefers the official Data API and only falls back to Apify when no API key is set."
              />
              <ReadinessRow
                ok={Boolean(data.health.lastRun && data.health.lastRun.status !== "failed")}
                label={`Last refresh: ${data.health.lastRun ? data.health.lastRun.status : "never run"}`}
                detail={
                  data.health.lastRun
                    ? `${formatDateTime(data.health.lastRun.startedAt)} · ${data.health.lastRun.videosUpdated} videos, ${data.health.lastRun.commentsUpdated} comments`
                    : "Run a refresh to validate the full pipeline"
                }
              />
              <ReadinessRow
                ok={data.readiness.cronSecretSet}
                label={`Cron: ${data.readiness.cronSecretSet ? "secret configured" : "CRON_SECRET missing"}`}
                detail="cron-job.org pings every 30 min (06:00-23:59 ET); app policy runs a full refresh hourly"
              />
              <ReadinessRow
                ok={data.readiness.adminPasswordSet}
                warnOnly
                label={`Admin password: ${data.readiness.adminPasswordSet ? "enabled" : "not set"}`}
                detail={
                  data.readiness.adminPasswordSet
                    ? "/admin requires sign-in"
                    : "Set ADMIN_PASSWORD before sharing the deployment"
                }
              />
              <ReadinessRow
                ok={(data.readiness.avgCompleteness ?? 0) >= 70}
                warnOnly
                label={`Data completeness: ${
                  data.readiness.avgCompleteness !== null
                    ? `${data.readiness.avgCompleteness}% avg`
                    : "no data yet"
                }`}
                detail="Average of per-video field-completeness scores — details per video below"
              />
            </CardBody>
          </Card>
        </section>

        <section id="automation">
          <RefreshHealthPanel runs={data.refreshRuns} />
        </section>

        <section id="providers">
          <Card>
            <CardHeader
              title="Metrics providers"
              subtitle="SocialCrawl is primary for TikTok / Instagram / Facebook; YouTube uses the official Data API; Apify is fallback only. Keys are never shown."
            />
            <CardBody className="space-y-3 text-xs">
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                {(["tiktok", "instagram", "facebook"] as const).map((p) => (
                  <div key={p} className="rounded-lg border border-border bg-surface px-3 py-2.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted-strong">{p}</div>
                    <div className="mt-1 font-medium capitalize">
                      {data.socialcrawl.providerByPlatform[p] === "socialcrawl" ? (
                        <span className="text-positive">SocialCrawl</span>
                      ) : (
                        <span className="text-warning">Apify (fallback)</span>
                      )}
                    </div>
                  </div>
                ))}
                <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-strong">youtube</div>
                  <div className="mt-1 font-medium text-positive">YouTube Data API</div>
                </div>
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
                <ReadinessRow
                  ok={data.socialcrawl.configured}
                  warnOnly
                  label={`SocialCrawl key: ${data.socialcrawl.configured ? "configured" : "not set"}`}
                  detail={
                    data.socialcrawl.enabled
                      ? "Primary metrics provider is active"
                      : "Add SOCIALCRAWL_API_KEY + SOCIALCRAWL_METRICS_ENABLED=true to activate"
                  }
                  tip="Server-only env var. The key value is never displayed or sent to the client."
                />
                <ReadinessRow
                  ok={data.socialcrawl.creditsToday < data.socialcrawl.dailyCap}
                  warnOnly
                  label={`Credits today: ${data.socialcrawl.creditsToday}/${data.socialcrawl.dailyCap}`}
                  detail={`${data.socialcrawl.calls} calls · ${data.socialcrawl.cached} cache hits · ${data.socialcrawl.failed} failed`}
                />
                <ReadinessRow
                  ok={data.socialcrawl.apifyFallbackAvailable}
                  warnOnly
                  label={`Apify fallback: ${data.socialcrawl.apifyFallbackAvailable ? "available" : "not configured"}`}
                  detail="Used only when SocialCrawl fails for a platform (cost-gated)."
                />
                <ReadinessRow
                  ok={data.socialcrawl.facebookViewSource === "socialcrawl_public_plays"}
                  warnOnly
                  label={`Facebook views: ${data.socialcrawl.facebookViewSource === "socialcrawl_public_plays" ? "public Reel plays (SocialCrawl)" : "Apify viewsCount (proxy)"}`}
                  detail="SocialCrawl returns the public Reel plays Apify's viewsCount undercounts."
                />
              </div>
            </CardBody>
          </Card>
        </section>

        <section id="youtube">
          <Card>
            <CardHeader
              title="YouTube provider"
              subtitle="Official YouTube Data API is preferred; the Apify scraper is fallback-only"
            />
            <CardBody className="grid gap-2.5 text-xs sm:grid-cols-2 xl:grid-cols-3">
              <ReadinessRow
                ok={data.youtubeProvider.mode === "youtube_api"}
                warnOnly
                label={`Active provider: ${
                  data.youtubeProvider.mode === "youtube_api" ? "YouTube Data API" : "Apify (fallback)"
                }`}
                detail={
                  data.youtubeProvider.mode === "youtube_api"
                    ? "Metrics come from the official API — 0 Apify runs for YouTube"
                    : "No API key detected — using the Apify YouTube scraper"
                }
                tip="Set by YOUTUBE_API_KEY presence. The key is server-only and never shown here."
              />
              <ReadinessRow
                ok={data.youtubeProvider.keyConfigured}
                warnOnly
                label={`API key: ${data.youtubeProvider.keyConfigured ? "configured" : "not set"}`}
                detail="Presence only — the key value is never displayed or sent to the browser"
              />
              <ReadinessRow
                ok={data.youtubeProvider.lastApiSuccessAt !== null}
                warnOnly
                label={`Last API success: ${
                  data.youtubeProvider.lastApiSuccessAt
                    ? formatDateTime(data.youtubeProvider.lastApiSuccessAt)
                    : "none yet"
                }`}
                detail={`${data.youtubeProvider.videosViaApiLastRun} video(s) refreshed via API on the last sweep`}
              />
              <ReadinessRow
                ok={data.youtubeProvider.lastApiFailureAt === null}
                warnOnly
                label={`Last API failure: ${
                  data.youtubeProvider.lastApiFailureAt
                    ? formatDateTime(data.youtubeProvider.lastApiFailureAt)
                    : "none"
                }`}
                detail={data.youtubeProvider.lastApiError ?? "No recent YouTube API errors"}
              />
              <ReadinessRow
                ok={!data.youtubeProvider.apifyFallbackUsedRecently}
                warnOnly
                label={`Apify fallback: ${
                  data.youtubeProvider.apifyFallbackUsedRecently ? "used recently" : "not used"
                }`}
                detail="The Apify YouTube scraper runs only when the API is unavailable"
              />
            </CardBody>
          </Card>
        </section>

        <section id="facebook">
          <Card>
            <CardHeader
              title="Facebook view diagnostics"
              subtitle="The Facebook actor's viewsCount is a stricter metric than the public 'plays' count and exposes no plays field. Use a manual correction (Tracked Content → Record correction) to set the real public play count — it is durable and audit-logged."
            />
            <CardBody className="overflow-x-auto text-xs">
              {data.facebookDiagnostics.length === 0 ? (
                <p className="text-muted">No Facebook videos tracked.</p>
              ) : (
                <table className="w-full min-w-[760px] text-left">
                  <thead className="text-[10px] uppercase tracking-wide text-muted-strong">
                    <tr className="border-b border-border">
                      <th className="py-1.5 pr-3 font-medium">Reel</th>
                      <th className="py-1.5 pr-3 font-medium">Resolved</th>
                      <th className="py-1.5 pr-3 font-medium">Path · confidence</th>
                      <th className="py-1.5 pr-3 font-medium">Shown (confirmed)</th>
                      <th className="py-1.5 pr-3 font-medium">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.facebookDiagnostics.map((d) => (
                      <tr key={d.videoId} className="border-b border-border/60 align-top">
                        <td className="max-w-[220px] py-2 pr-3">
                          <div className="truncate font-medium">{d.title ?? d.urlSlug}</div>
                          <div className="truncate font-mono text-[10px] text-muted-strong">{d.urlSlug}</div>
                        </td>
                        <td className="tabular py-2 pr-3">
                          {d.resolvedViews !== null ? d.resolvedViews.toLocaleString("en-US") : "—"}
                          {d.rawDisplayValue && (
                            <div className="text-[10px] text-muted-strong">raw: {d.rawDisplayValue}</div>
                          )}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[10px] text-muted">
                          {d.extractionPath ?? "—"}
                          <div
                            className={
                              d.viewConfidence === "exact" || d.viewConfidence === "display_string"
                                ? "text-positive"
                                : d.viewConfidence === "proxy"
                                  ? "text-warning"
                                  : "text-muted-strong"
                            }
                          >
                            {d.viewConfidence} · {d.sourceSurface}
                          </div>
                        </td>
                        <td className="tabular py-2 pr-3">
                          {d.confirmedViews !== null ? d.confirmedViews.toLocaleString("en-US") : "—"}
                        </td>
                        <td className="py-2 pr-3 text-[10px]">
                          {d.manualVerified && <span className="text-positive">verified </span>}
                          {d.stale && <span className="text-warning">stale </span>}
                          {d.monotonicPreserved && <span className="text-muted">preserved </span>}
                          {!d.hasThumbnail && <span className="text-negative">no-thumb </span>}
                          {d.duplicateCandidateIds.length > 0 && (
                            <span className="text-negative">dupe×{d.duplicateCandidateIds.length} </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>
        </section>

        <section id="review">
          <Card>
            <CardHeader
              title="Review queue — unmatched / out-of-campaign content"
              subtitle="Records excluded from every total by the campaign-eligibility filter (invalid/epoch dates or content published before the campaign start). Refreshes update only already-tracked campaign videos; profile-feed content is never auto-imported. These do not count anywhere — review and exclude permanently if desired."
            />
            <CardBody>
              <ReviewQueue items={data.quarantinedVideos} />
            </CardBody>
          </Card>
        </section>

        <section id="milestones">
          <Card>
            <CardHeader
              title="Campaign milestones (diagnostics)"
              subtitle="All milestones the engine fires from the latest snapshot — computed dynamically (lifetime view), not persisted"
            />
            <CardBody className="text-xs">
              {data.milestones.length === 0 ? (
                <p className="text-muted">No milestones supported by the current data yet.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border">
                  {data.milestones.map((m) => (
                    <li key={m.id} className="flex items-start gap-3 py-2">
                      <span
                        className="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{
                          color:
                            m.severity === "major"
                              ? "var(--accent)"
                              : m.severity === "notable"
                                ? "var(--foreground)"
                                : "var(--muted-strong)",
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        {m.severity}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">
                          {m.title}
                          <span className="ml-2 font-mono text-[10px] text-muted-strong">[{m.type}]</span>
                        </div>
                        <div className="text-muted">{m.description}</div>
                      </div>
                      <span className="tabular shrink-0 text-muted-strong">
                        {m.value !== null ? new Intl.NumberFormat("en-US").format(m.value) : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </section>

        <section id="episodes">
          <EpisodeManager
            episodes={data.episodeRollups}
            unassignedVideoCount={data.unassignedVideoCount}
          />
        </section>

        <section id="campaign">
          <CampaignSettings campaign={data.campaign} storeInfo={data.health.store} />
        </section>

        <section id="apify">
          <ApifySetup
            tokenStatus={data.tokenStatus}
            providerConfigs={data.providerConfigs}
            healthPlatforms={data.health.platforms}
            candidates={CANDIDATE_ACTORS}
            seedVideos={SEED_VIDEOS}
            seedProfiles={SEED_PROFILES}
            envKeys={{
              tiktok: actorEnvKey("tiktok"),
              instagram: actorEnvKey("instagram"),
              facebook: actorEnvKey("facebook"),
              youtube: actorEnvKey("youtube"),
            }}
          />
        </section>

        <section id="content">
          <ContentManager
            videos={data.videos}
            episodes={data.episodes}
            profiles={data.profiles}
            seedVideos={SEED_VIDEOS}
            seedProfiles={SEED_PROFILES}
            completeness={data.completeness}
          />
        </section>

        <section id="attempts">
          <Card>
            <CardHeader
              title="Collection attempts"
              subtitle="Every source tried per refresh — success and failure alike"
            />
            <CardBody>
              {data.attempts.length === 0 ? (
                <p className="text-xs text-muted">
                  No attempts logged yet — they appear from the next refresh onward.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-xs">
                    <thead className="text-muted-strong">
                      <tr>
                        <th className="py-1.5 pr-3 font-medium">When</th>
                        <th className="py-1.5 pr-3 font-medium">Platform</th>
                        <th className="py-1.5 pr-3 font-medium">Source</th>
                        <th className="py-1.5 pr-3 font-medium">Kind</th>
                        <th className="py-1.5 pr-3 font-medium">Input</th>
                        <th className="py-1.5 pr-3 font-medium">Items</th>
                        <th className="py-1.5 font-medium">Result</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.attempts.map((a) => (
                        <tr key={a.id}>
                          <td className="py-2 pr-3 whitespace-nowrap text-muted">
                            <TimeAgo iso={a.capturedAt} />
                          </td>
                          <td className="py-2 pr-3">{a.platform}</td>
                          <td className="max-w-44 truncate py-2 pr-3 font-mono text-[10px] text-muted" title={a.actorId ?? a.provider}>
                            {a.provider === "apify" ? (a.actorId ?? "apify") : a.provider}
                          </td>
                          <td className="py-2 pr-3">
                            <span
                              className={
                                a.kind === "backup"
                                  ? "rounded bg-[rgba(251,191,36,0.1)] px-1.5 py-0.5 text-[10px] font-medium text-warning"
                                  : "text-muted"
                              }
                            >
                              {a.kind}
                            </span>
                          </td>
                          <td className="max-w-56 truncate py-2 pr-3 text-muted" title={a.inputDescription}>
                            {a.inputDescription}
                          </td>
                          <td className="tabular py-2 pr-3">{a.itemCount}</td>
                          <td className="py-2">
                            {a.success ? (
                              <span className="text-positive">ok</span>
                            ) : (
                              <span className="text-negative" title={a.error ?? undefined}>
                                failed{a.runId ? ` (run ${a.runId.slice(0, 8)}…)` : ""}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </section>

        <section id="logs">
          <Card>
            <CardHeader title="Refresh logs" subtitle="Most recent runs first" />
            <CardBody>
              {data.refreshRuns.length === 0 ? (
                <p className="text-xs text-muted">No refresh runs yet.</p>
              ) : (
                <div className="space-y-3">
                  {data.refreshRuns.map((run) => (
                    <div key={run.id} className="rounded-lg border border-border bg-surface px-4 py-3 text-xs">
                      <div className="flex flex-wrap items-center gap-3">
                        <span
                          className={
                            run.status === "success"
                              ? "font-semibold text-positive"
                              : run.status === "failed"
                                ? "font-semibold text-negative"
                                : run.status === "running"
                                  ? "font-semibold text-accent animate-pulse"
                                  : "font-semibold text-warning"
                          }
                        >
                          {run.status.toUpperCase()}
                        </span>
                        <span className="text-muted">{run.trigger}</span>
                        <span className="text-muted">{formatDateTime(run.startedAt)}</span>
                        <span className="text-muted-strong">
                          <TimeAgo iso={run.startedAt} />
                        </span>
                        <span className="ml-auto text-muted">
                          {run.videosUpdated} videos · {run.commentsUpdated} comments ·{" "}
                          {run.newVideosDiscovered} discovered
                        </span>
                      </div>
                      {run.errors.length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-negative">
                            {run.errors.length} error(s)
                          </summary>
                          <ul className="mt-1 list-disc pl-5 text-negative/90">
                            {run.errors.map((e, i) => (
                              <li key={i}>{e}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {run.rawLog && run.rawLog.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-muted-strong">raw log</summary>
                          <pre className="mt-1 overflow-x-auto rounded bg-background p-2 font-mono text-[10px] text-muted">
                            {run.rawLog.join("\n")}
                          </pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </section>

        <section id="overrides">
          <Card>
            <CardHeader title="Manual override log" subtitle="Audit trail of admin edits" />
            <CardBody>
              {data.overrides.length === 0 ? (
                <p className="text-xs text-muted">No manual overrides recorded.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted-strong">
                      <tr>
                        <th className="py-1.5 pr-4 font-medium">When</th>
                        <th className="py-1.5 pr-4 font-medium">Entity</th>
                        <th className="py-1.5 pr-4 font-medium">Field</th>
                        <th className="py-1.5 pr-4 font-medium">Change</th>
                        <th className="py-1.5 font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {data.overrides.map((o) => (
                        <tr key={o.id}>
                          <td className="py-2 pr-4 whitespace-nowrap text-muted">
                            <TimeAgo iso={o.createdAt} />
                          </td>
                          <td className="py-2 pr-4 text-muted">{o.entityType}</td>
                          <td className="py-2 pr-4">{o.field}</td>
                          <td className="max-w-64 truncate py-2 pr-4 text-muted" title={`${o.oldValue ?? "—"} → ${o.newValue ?? "—"}`}>
                            {(o.oldValue ?? "—").slice(0, 30)} → {(o.newValue ?? "—").slice(0, 30)}
                          </td>
                          <td className="py-2 text-muted">{o.reason ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </section>
      </div>
    </div>
  );
}
