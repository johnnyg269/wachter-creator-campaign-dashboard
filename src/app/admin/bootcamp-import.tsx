"use client";

// Admin Bootcamp import window config + DRY RUN (Phase 2A). Pre-filled with the
// configured start date + per-platform anchor URLs. The admin can adjust the
// window, paste back-catalog URLs (TikTok/Instagram/Facebook can't be crawled —
// SocialCrawl lists only the ~10 most recent; YouTube auto-enumerates for free),
// then run a credit-safe dry run that resolves the anchors and classifies
// candidates WITHOUT writing anything. The approve/write step lands in Phase 2B.

import { useState } from "react";
import type { BootcampImportConfig, BootcampDryRunReport, CandidateClass } from "@/lib/bootcamp-import";
import { CANDIDATE_CLASS_LABEL } from "@/lib/bootcamp-import";
import type { Platform } from "@/lib/types";

const PLATFORMS: Platform[] = ["tiktok", "instagram", "facebook", "youtube"];
const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram Reels",
  facebook: "Facebook Reels",
  youtube: "YouTube Shorts",
};

interface PlatformForm {
  startDate: string;
  anchorUrl: string;
  pastedUrls: string;
  maxCandidates: string;
  maxPages: string;
  safetyStopDate: string;
}

function initForm(defaults: BootcampImportConfig): Record<Platform, PlatformForm> {
  const out = {} as Record<Platform, PlatformForm>;
  for (const p of PLATFORMS) {
    const d = defaults.platforms[p];
    out[p] = {
      startDate: d.startDate,
      anchorUrl: d.anchorUrl ?? "",
      pastedUrls: "",
      maxCandidates: "",
      maxPages: "",
      safetyStopDate: "",
    };
  }
  return out;
}

const SHOWN_CLASSES: CandidateClass[] = [
  "suggested_bootcamp",
  "suggested_bootcamp_unresolved",
  "overlap",
  "already_mtl",
  "already_bootcamp",
  "already_unassigned",
  "already_excluded",
  "before_start",
  "invalid_date",
  "invalid_url",
];

export function BootcampImport({ defaults }: { defaults: BootcampImportConfig }) {
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [forms, setForms] = useState<Record<Platform, PlatformForm>>(() => initForm(defaults));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<BootcampDryRunReport | null>(null);

  const update = (p: Platform, k: keyof PlatformForm, v: string) =>
    setForms((f) => ({ ...f, [p]: { ...f[p], [k]: v } }));

  async function runDryRun() {
    setBusy(true);
    setError(null);
    try {
      const platforms = Object.fromEntries(
        PLATFORMS.map((p) => [
          p,
          {
            startDate: forms[p].startDate || startDate,
            anchorUrl: forms[p].anchorUrl,
            pastedUrls: forms[p].pastedUrls,
            maxCandidates: forms[p].maxCandidates,
            maxPages: forms[p].maxPages,
            safetyStopDate: forms[p].safetyStopDate,
          },
        ]),
      );
      const res = await fetch("/api/admin/bootcamp-import/dry-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, platforms }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; report?: BootcampDryRunReport }
        | null;
      if (data?.ok && data.report) setReport(data.report);
      else setError(data?.error ?? "Dry run failed");
    } catch {
      setError("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[11px] text-muted">
        Bootcamp and MTL overlap, so date never auto-assigns a campaign — the dry run only{" "}
        <strong>suggests</strong>. Manual assignment stays the source of truth. TikTok / Instagram /
        Facebook can&apos;t be crawled (SocialCrawl returns only the ~10 most recent and doesn&apos;t
        paginate) — paste the back-catalog URLs to import them (1 credit each, verified on import).
        YouTube Shorts auto-enumerate from the start date (free). The dry run never writes a video.
      </div>

      <label className="flex items-center gap-2">
        <span className="font-medium">Bootcamp start date (all platforms):</span>
        <input
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          className="rounded border border-border bg-surface px-2 py-1"
        />
      </label>

      <div className="grid gap-3 lg:grid-cols-2">
        {PLATFORMS.map((p) => (
          <div key={p} className="rounded-lg border border-border bg-surface p-3 space-y-2">
            <div className="font-semibold">{PLATFORM_LABEL[p]}</div>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-strong">Anchor URL (first Bootcamp video)</span>
              <input
                type="text"
                value={forms[p].anchorUrl}
                onChange={(e) => update(p, "anchorUrl", e.target.value)}
                placeholder="https://…"
                className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[10px]"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-muted-strong">
                {p === "youtube" ? "Extra URLs (optional — YouTube auto-enumerates)" : "Paste back-catalog URLs (newline/CSV)"}
              </span>
              <textarea
                value={forms[p].pastedUrls}
                onChange={(e) => update(p, "pastedUrls", e.target.value)}
                rows={3}
                placeholder={p === "youtube" ? "(optional)" : "https://…\nhttps://…"}
                className="mt-0.5 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[10px]"
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-1">
                <span className="text-[10px] text-muted-strong">max candidates</span>
                <input
                  type="number"
                  min={1}
                  value={forms[p].maxCandidates}
                  onChange={(e) => update(p, "maxCandidates", e.target.value)}
                  className="w-16 rounded border border-border bg-background px-1 py-0.5"
                />
              </label>
              {p === "youtube" && (
                <label className="flex items-center gap-1">
                  <span className="text-[10px] text-muted-strong">max pages</span>
                  <input
                    type="number"
                    min={1}
                    value={forms[p].maxPages}
                    onChange={(e) => update(p, "maxPages", e.target.value)}
                    className="w-16 rounded border border-border bg-background px-1 py-0.5"
                  />
                </label>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={runDryRun}
          className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 font-medium text-accent hover:bg-accent/20 disabled:opacity-50"
        >
          {busy ? "Running dry run…" : "Run dry run (no writes)"}
        </button>
        {error && <span className="text-negative">{error}</span>}
      </div>

      {report && <DryRunResult report={report} />}
    </div>
  );
}

function DryRunResult({ report }: { report: BootcampDryRunReport }) {
  const t = report.totals;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">Dry-run result (nothing written)</div>
      <div className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Metric label="Candidates" value={t.candidatesFound} />
        <Metric label="Importable" value={t.importable} />
        <Metric label="Suggested Bootcamp" value={t.suggestedBootcamp} />
        <Metric label="Overlap → review" value={t.overlap} />
        <Metric label="Already MTL" value={t.alreadyMtl} />
        <Metric label="Already Bootcamp" value={t.alreadyBootcamp} />
        <Metric label="Removed (skipped)" value={t.alreadyExcluded} />
        <Metric label="Before start" value={t.beforeStart} />
        <Metric label="Invalid" value={t.invalid} />
        <Metric label="Est. SocialCrawl credits" value={t.estSocialcrawlCredits} />
        <Metric label="Est. YouTube calls (free)" value={t.estYoutubeCalls} />
      </div>
      <div
        className={`rounded-lg border px-3 py-2 ${
          report.fitsUnderTodayCap ? "border-positive/40 text-positive" : "border-warning/50 text-warning"
        }`}
      >
        {report.fitsUnderTodayCap
          ? `Fits under today's remaining cap (need ${t.estSocialcrawlCredits}, ${report.headroomToday} headroom of ${report.creditCap}/day).`
          : `Exceeds today's remaining cap (need ${t.estSocialcrawlCredits}, only ${report.headroomToday} headroom of ${report.creditCap}/day) — import will spread across days/batches.`}
        {report.remainingTotal !== null && ` Balance: ${report.remainingTotal.toLocaleString("en-US")} credits.`}
      </div>

      {report.platforms.map((pr) => (
        <div key={pr.platform} className="rounded-lg border border-border bg-surface p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{PLATFORM_LABEL[pr.platform]}</span>
            <span className="text-muted">start {pr.startDate}</span>
            {pr.anchorUrl && (
              <span className={pr.anchorResolved ? "text-positive" : "text-negative"}>
                anchor {pr.anchorResolved ? "resolved ✓" : "did not resolve"}
                {pr.anchorIncludedAsCandidate ? " · included" : ""}
              </span>
            )}
            <span className="ml-auto text-muted-strong">
              {pr.candidatesFound} candidate(s) · {pr.estSocialcrawlCredits} cr
              {pr.estYoutubeCalls ? ` · ${pr.estYoutubeCalls} YT calls` : ""}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
            {SHOWN_CLASSES.filter((c) => pr.byClass[c] > 0).map((c) => (
              <span key={c}>
                {CANDIDATE_CLASS_LABEL[c]}: <span className="tabular text-foreground">{pr.byClass[c]}</span>
              </span>
            ))}
          </div>
          {pr.notes.map((n, i) => (
            <div key={i} className="mt-1 text-[10px] text-muted-strong">
              • {n}
            </div>
          ))}
        </div>
      ))}
      <p className="text-[10px] text-muted-strong">
        Approve &amp; write lands in Phase 2B. Importable = suggested + overlap + invalid-date (needs review);
        already-MTL / already-Bootcamp / removed are never overwritten or re-added.
      </p>
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
