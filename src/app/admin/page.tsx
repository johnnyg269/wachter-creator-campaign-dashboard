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

export const dynamic = "force-dynamic";

const SECTIONS = [
  { id: "campaign", label: "Campaign" },
  { id: "apify", label: "Apify Setup" },
  { id: "content", label: "Tracked Content" },
  { id: "logs", label: "Refresh Logs" },
  { id: "overrides", label: "Override Log" },
];

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
        actions={<RefreshButton />}
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
          />
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
