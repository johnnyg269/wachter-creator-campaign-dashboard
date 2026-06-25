"use client";

// Admin Bootcamp BACKFILL — automatic historical discovery (Phase 2B). This is
// the PRIMARY import workflow: it enumerates the back-catalog from the start date
// via a paginating provider (Apify for TikTok/Instagram/Facebook, YouTube Data
// API for Shorts) — no manual URL collection. Admin-triggered, dry-run first,
// cost-capped, NEVER writes here (approve/write is a separate later step). The
// CSV/paste form remains only as a fallback for edge cases.

import { useState } from "react";
import type { BackfillDryRunReport, BackfillPlatformReport, BackfillCandidate } from "@/lib/backfill";
import { CANDIDATE_CLASS_LABEL } from "@/lib/bootcamp-import";
import type { Platform } from "@/lib/types";

const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram Reels",
  facebook: "Facebook Reels",
  youtube: "YouTube Shorts",
};

export function BootcampBackfill({
  defaults,
}: {
  defaults: { startDate: string; provider: string; maxProviderCalls: number; maxCostUsd: number; enabled: boolean };
}) {
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [maxCalls, setMaxCalls] = useState(String(defaults.maxProviderCalls));
  const [maxCost, setMaxCost] = useState(String(defaults.maxCostUsd));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabledMsg, setDisabledMsg] = useState<string | null>(null);
  const [report, setReport] = useState<BackfillDryRunReport | null>(null);

  async function runDryRun() {
    if (!window.confirm("Run the automatic backfill DRY RUN? This calls Apify for TikTok/Instagram/Facebook (one-time, cost-capped) and the YouTube API. It writes NO records.")) return;
    setBusy(true);
    setError(null);
    setDisabledMsg(null);
    setReport(null);
    try {
      const res = await fetch("/api/admin/bootcamp-backfill/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, provider: "apify", startDate, maxProviderCalls: Number(maxCalls) || undefined, maxCostUsd: Number(maxCost) || undefined }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; report?: BackfillDryRunReport; disabled?: boolean; message?: string }
        | null;
      if (data?.disabled) setDisabledMsg(data.message ?? "Backfill is disabled.");
      else if (data?.ok && data.report) setReport(data.report);
      else setError(data?.error ?? "Backfill dry run failed");
    } catch {
      setError("Request failed (the run can take 1–3 minutes for Facebook).");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[11px] text-muted">
        <strong>Automatic discovery</strong> enumerates the CyberNick0x back-catalog from the start date forward — no manual URL
        collection. TikTok/Instagram/Facebook use Apify profile scrapers (they paginate, unlike SocialCrawl&apos;s ~10-item
        window); YouTube uses the free Data API. This is a <strong>one-time, admin-triggered, cost-capped DRY RUN that writes
        nothing</strong> and does <strong>not</strong> re-enable Apify for ongoing refresh. Manual assignment stays the source of
        truth — already-MTL is never overwritten, removed videos are never re-added. Approve &amp; write is the next step.
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-strong">Start date (floor)</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded border border-border bg-surface px-2 py-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-strong">Max provider calls</span>
          <input type="number" min={1} value={maxCalls} onChange={(e) => setMaxCalls(e.target.value)} className="w-24 rounded border border-border bg-surface px-2 py-1" />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-strong">Max cost (USD)</span>
          <input type="number" min={1} value={maxCost} onChange={(e) => setMaxCost(e.target.value)} className="w-24 rounded border border-border bg-surface px-2 py-1" />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={runDryRun}
          className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? "Discovering… (up to ~3 min)" : "Run automatic backfill dry run"}
        </button>
        {error && <span className="text-negative">{error}</span>}
      </div>
      {disabledMsg && <div className="rounded-lg border border-warning/50 px-3 py-2 text-warning">{disabledMsg}</div>}

      {report && <BackfillResult report={report} />}
    </div>
  );
}

function BackfillResult({ report }: { report: BackfillDryRunReport }) {
  const t = report.totals;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted">Backfill dry-run result (nothing written)</span>
        <span className="text-muted">start {report.startDate}</span>
        <span className="text-muted">provider calls {t.providerCalls}/{report.maxProviderCalls}</span>
        <span className={t.estCostUsd !== null && t.estCostUsd > report.maxCostUsd ? "text-negative" : "text-muted"}>
          est cost {t.estCostUsd === null ? "—" : `$${t.estCostUsd.toFixed(4)}`}/${report.maxCostUsd}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Metric label="Candidates" value={t.candidatesFound} />
        <Metric label="Importable" value={t.importable} />
        <Metric label="Suggested Bootcamp" value={t.suggestedBootcamp} />
        <Metric label="Overlap → review" value={t.overlap} />
        <Metric label="Already MTL" value={t.alreadyMtl} />
        <Metric label="Already Bootcamp" value={t.alreadyBootcamp} />
        <Metric label="Removed (skipped)" value={t.alreadyExcluded} />
        <Metric label="Invalid" value={t.invalid} />
      </div>

      {report.platforms.map((p) => (
        <PlatformBlock key={p.platform} p={p} />
      ))}
      <p className="text-[10px] text-muted-strong">
        Importable = suggested + overlap + needs-review. Already-MTL / already-Bootcamp / removed are never overwritten or
        re-added. The approve &amp; write step (next) creates only the candidates you select; Bootcamp → daily tier, MTL → hot/warm
        by age.
      </p>
    </div>
  );
}

function PlatformBlock({ p }: { p: BackfillPlatformReport }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">{PLATFORM_LABEL[p.platform]}</span>
        <span className="text-muted">{p.provider}</span>
        <span className={p.ran ? "text-positive" : "text-muted-strong"}>{p.ran ? "ran" : "skipped"}</span>
        {p.anchorFound !== null && (
          <span className={p.anchorFound ? "text-positive" : "text-negative"}>anchor {p.anchorFound ? "found ✓" : "not found"}</span>
        )}
        <span className="text-muted">{p.earliest ?? "—"} → {p.latest ?? "—"}</span>
        <span className="ml-auto text-muted-strong">
          {p.candidatesFound} found · {p.providerCalls} call(s){p.estCostUsd !== null ? ` · $${p.estCostUsd.toFixed(4)}` : ""} · stop: {p.stopReason}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
        {(Object.keys(p.byClass) as Array<keyof typeof p.byClass>)
          .filter((c) => p.byClass[c] > 0)
          .map((c) => (
            <span key={c}>
              {CANDIDATE_CLASS_LABEL[c]}: <span className="tabular text-foreground">{p.byClass[c]}</span>
            </span>
          ))}
      </div>
      {p.notes.map((n, i) => (
        <div key={i} className="mt-1 text-[10px] text-muted-strong">• {n}</div>
      ))}
      {p.candidates.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted">Review {p.candidates.length} candidate(s)</summary>
          <div className="mt-2 space-y-1.5">
            {p.candidates.map((c, i) => (
              <CandidateRow key={i} c={c} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function CandidateRow({ c }: { c: BackfillCandidate }) {
  return (
    <div className="flex items-start gap-2 rounded border border-border/60 bg-background px-2 py-1.5">
      {c.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={c.thumbnailUrl} alt="" className="h-12 w-9 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-12 w-9 shrink-0 rounded bg-surface" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{c.title ?? c.caption ?? c.canonicalUrl ?? "(untitled)"}</div>
        <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-strong">
          <span>{c.publishedAt ? c.publishedAt.slice(0, 10) : "no date"}</span>
          {c.views !== null && <span>{c.views.toLocaleString("en-US")} views</span>}
          {c.canonicalUrl && (
            <a href={c.canonicalUrl} target="_blank" rel="noopener noreferrer" className="truncate text-accent hover:underline">
              {c.canonicalUrl.replace(/^https?:\/\/(www\.)?/, "")}
            </a>
          )}
        </div>
        <div className="text-[10px]">
          <span className={c.suggestedCampaign === "bootcamp" ? "text-positive" : "text-muted"}>{CANDIDATE_CLASS_LABEL[c.classification]}</span>
          <span className="text-muted-strong"> — {c.reason}</span>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-border bg-surface px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-muted-strong">{label}</div>
      <div className="tabular text-sm font-semibold">{value.toLocaleString("en-US")}</div>
    </div>
  );
}
