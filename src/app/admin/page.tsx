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
import { formatDateTime } from "@/lib/format";
import { LoginForm } from "./login-form";
import { ApifySetup } from "./apify-setup";
import { CampaignSettings } from "./campaign-settings";
import { ContentManager } from "./content-manager";
import { RefreshHealthPanel } from "./refresh-health";
import { EpisodeManager } from "./episode-manager";

export const dynamic = "force-dynamic";

const SECTIONS = [
  { id: "readiness", label: "Production Readiness" },
  { id: "automation", label: "Refresh Health" },
  { id: "youtube", label: "YouTube Provider" },
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
}: {
  ok: boolean;
  label: string;
  detail: string;
  /** Render a soft warning instead of a hard red when not ok. */
  warnOnly?: boolean;
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
        <div className="font-medium">{label}</div>
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
                ok={(Object.values(data.readiness.actorIds) as Array<string | null>).every(Boolean)}
                label={`Actor IDs: ${
                  (Object.values(data.readiness.actorIds) as Array<string | null>).filter(Boolean).length
                }/4 configured`}
                detail={(["tiktok", "instagram", "facebook", "youtube"] as const)
                  .map((p) => `${p}: ${data.readiness.actorIds[p] ? "✓" : "—"}`)
                  .join("  ")}
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
