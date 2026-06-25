"use client";

// Admin Bootcamp BACKFILL — automatic discovery + REVIEW QUEUE + approve→write
// (Phase 2B-final). Step 1 run the automatic dry run (one platform per request,
// merged); step 2 review/select candidates; step 3 review credit impact; step 4
// import the selected ones. The dry run writes NOTHING; records are created only
// on import. Already-MTL is shown but never selected/overwritten by default;
// excluded videos are never re-added; no duplicates. Admin-only; no secrets.

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BackfillDryRunReport, BackfillPlatformReport, BackfillCandidate } from "@/lib/backfill";
import { CANDIDATE_CLASS_LABEL } from "@/lib/bootcamp-import";
import type { ImportAssignment } from "@/lib/backfill-import";
import type { Platform } from "@/lib/types";

const PLATFORM_LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram Reels",
  facebook: "Facebook Reels",
  youtube: "YouTube Shorts",
};
const ORDER: Platform[] = ["youtube", "tiktok", "instagram", "facebook"];
type Cls = keyof BackfillPlatformReport["byClass"];

function defaultAssign(cls: Cls): ImportAssignment {
  if (cls === "suggested_bootcamp" || cls === "suggested_bootcamp_unresolved") return "bootcamp";
  if (cls === "already_mtl") return "mtl";
  if (cls === "already_bootcamp") return "bootcamp";
  if (cls === "already_excluded") return "exclude";
  if (cls === "overlap") return "unassigned";
  return "ignore"; // before_start / invalid_*
}
const isSuggested = (c: Cls) => c === "suggested_bootcamp" || c === "suggested_bootcamp_unresolved";
const importable = (c: Cls) => c !== "before_start" && c !== "invalid_url";

interface Row {
  id: string;
  platform: Platform;
  c: BackfillCandidate;
  assign: ImportAssignment;
  selected: boolean;
}

interface PreviewData {
  selected: number;
  byAssignment: Record<string, number>;
  byPlatform: Record<string, number>;
  estInitialMetricsCredits: number;
  cap: number;
  usedToday: number;
  headroom: number;
  remaining: number | null;
  estDaysRemaining: number | null;
  estBootcampDailyRefreshCost: number;
  fitsUnderCap: boolean;
  pendingIfImportedNow: number;
}
interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  excluded: number;
  assignedBootcamp: number;
  assignedMtl: number;
  assignedUnassigned: number;
  pendingMetrics: number;
  creditsUsed: number;
  skippedReasons: Record<string, number>;
  errors: string[];
}

export function BootcampBackfill({
  defaults,
}: {
  defaults: { startDate: string; provider: string; maxProviderCalls: number; maxCostUsd: number; enabled: boolean };
}) {
  const router = useRouter();
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [maxCalls, setMaxCalls] = useState(String(defaults.maxProviderCalls));
  const [maxCost, setMaxCost] = useState(String(defaults.maxCostUsd));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disabledMsg, setDisabledMsg] = useState<string | null>(null);
  const [report, setReport] = useState<BackfillDryRunReport | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const selectedCount = useMemo(() => rows.filter((r) => r.selected).length, [rows]);

  // ── Step 1: run the dry run (one platform per request, merged) ────────────
  async function runDryRun() {
    if (!window.confirm("Run the automatic backfill DRY RUN? It enumerates each platform one at a time (YouTube free, then TikTok/Instagram/Facebook via Apify, one-time + cost-capped). It writes NO records.")) return;
    setBusy(true);
    setError(null);
    setDisabledMsg(null);
    setReport(null);
    setRows([]);
    setPreview(null);
    setResult(null);
    const collected: BackfillDryRunReport["platforms"] = [];
    try {
      for (const p of ORDER) {
        setProgress(`Discovering ${PLATFORM_LABEL[p]}… (${collected.length}/${ORDER.length} done)`);
        const res = await fetch("/api/admin/bootcamp-backfill/dry-run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true, provider: "apify", platform: p, startDate, maxProviderCalls: Number(maxCalls) || undefined, maxCostUsd: Number(maxCost) || undefined }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; report?: BackfillDryRunReport; disabled?: boolean; message?: string } | null;
        if (data?.disabled) { setDisabledMsg(data.message ?? "Backfill is disabled."); break; }
        if (data?.ok && data.report) {
          collected.push(...data.report.platforms);
          setReport(mergeReports(collected, data.report));
          setRows(buildRows(collected));
        } else {
          setError(`${PLATFORM_LABEL[p]}: ${data?.error ?? "failed"} (continuing)`);
        }
      }
    } catch {
      setError("A request failed (a platform run can take up to ~3 minutes).");
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  // ── Selection / assignment helpers ────────────────────────────────────────
  const setRow = (id: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const bulk = (pred: (r: Row) => boolean, patch: (r: Row) => Partial<Row>) =>
    setRows((rs) => rs.map((r) => (pred(r) ? { ...r, ...patch(r) } : r)));
  const assignSelected = (assign: ImportAssignment) => bulk((r) => r.selected, () => ({ assign }));

  async function reviewImpact() {
    setBusy(true); setError(null); setPreview(null); setResult(null);
    try {
      const res = await fetch("/api/admin/bootcamp-backfill/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preview: true, candidates: payload(rows) }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok) setPreview(data as PreviewData);
      else setError(data?.error ?? "Preview failed");
    } catch { setError("Preview request failed"); } finally { setBusy(false); }
  }

  async function doImport() {
    if (!preview) return;
    if (!window.confirm(`Import ${preview.selected} candidate(s)? This creates active tracked videos only for the selected items. Already-MTL is not overwritten unless you explicitly chose it; excluded videos are not re-added; Bootcamp videos refresh once per day.`)) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/admin/bootcamp-backfill/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true, candidates: payload(rows) }),
      });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.result) { setResult(data.result as ImportResult); setPreview(null); router.refresh(); }
      else setError(data?.error ?? "Import failed");
    } catch { setError("Import request failed"); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-4 text-xs">
      <div className="rounded-lg border border-border bg-surface px-3 py-2.5 text-[11px] text-muted">
        <strong>Workflow:</strong> 1) run the automatic dry run · 2) review &amp; select candidates · 3) review credit impact ·
        4) import selected · 5) see the result. <strong>Nothing is written until you import.</strong> Already-MTL videos are
        shown but not selected by default and are never overwritten; excluded videos are never re-added; Bootcamp videos refresh
        once per day. Ongoing metrics stay on SocialCrawl; the write step never uses Apify.
      </div>

      {/* Step 1 */}
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
        <button type="button" disabled={busy} onClick={runDryRun} className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 font-medium text-accent hover:bg-accent/20 disabled:opacity-50">
          {busy && progress ? "Discovering…" : "1 · Run automatic backfill dry run"}
        </button>
        {progress && <span className="text-muted">{progress}</span>}
        {error && <span className="text-negative">{error}</span>}
      </div>
      {disabledMsg && <div className="rounded-lg border border-warning/50 px-3 py-2 text-warning">{disabledMsg}</div>}

      {report && <SummaryStrip report={report} />}

      {/* Step 2: review queue */}
      {rows.length > 0 && (
        <ReviewQueue
          rows={rows}
          report={report}
          setRow={setRow}
          bulk={bulk}
          assignSelected={assignSelected}
          selectedCount={selectedCount}
          busy={busy}
          onReview={reviewImpact}
        />
      )}

      {/* Step 4: credit confirmation */}
      {preview && <CreditConfirm preview={preview} busy={busy} onImport={doImport} />}

      {/* Step 6: result */}
      {result && <ImportResultView result={result} />}
    </div>
  );
}

function buildRows(platforms: BackfillDryRunReport["platforms"]): Row[] {
  const out: Row[] = [];
  for (const p of platforms) {
    for (const c of p.candidates) {
      const cls = c.classification as Cls;
      out.push({
        id: `${c.platform}:${c.externalVideoId ?? c.canonicalUrl ?? c.url ?? Math.random()}`,
        platform: c.platform ?? p.platform,
        c,
        assign: defaultAssign(cls),
        selected: isSuggested(cls), // suggested Bootcamp selected by default; already-MTL NOT
      });
    }
  }
  return out;
}

function payload(rows: Row[]) {
  return rows
    .filter((r) => r.selected)
    .map((r) => ({
      platform: r.platform,
      url: r.c.canonicalUrl ?? r.c.url ?? "",
      externalVideoId: r.c.externalVideoId,
      publishedAt: r.c.publishedAt,
      title: r.c.title,
      caption: r.c.caption,
      thumbnailUrl: r.c.thumbnailUrl,
      assignment: r.assign,
    }));
}

function SummaryStrip({ report }: { report: BackfillDryRunReport }) {
  const t = report.totals;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-background px-3 py-2 text-[11px]">
      <span className="font-semibold uppercase tracking-wide text-muted">Discovered (nothing written)</span>
      <span>candidates {t.candidatesFound}</span>
      <span className="text-positive">suggested Bootcamp {t.suggestedBootcamp}</span>
      <span>already-MTL {t.alreadyMtl}</span>
      <span>provider calls {t.providerCalls}</span>
      <span className={t.estCostUsd !== null && t.estCostUsd > report.maxCostUsd ? "text-negative" : "text-muted"}>
        Apify cost {t.estCostUsd === null ? "—" : `$${t.estCostUsd.toFixed(3)}`}
      </span>
      {report.platforms.map((p) => (
        <span key={p.platform} className="text-muted-strong">
          {PLATFORM_LABEL[p.platform]}: {p.candidatesFound} {p.anchorFound ? "⚓" : ""}
        </span>
      ))}
    </div>
  );
}

function ReviewQueue({
  rows, report, setRow, bulk, assignSelected, selectedCount, busy, onReview,
}: {
  rows: Row[];
  report: BackfillDryRunReport | null;
  setRow: (id: string, patch: Partial<Row>) => void;
  bulk: (pred: (r: Row) => boolean, patch: (r: Row) => Partial<Row>) => void;
  assignSelected: (a: ImportAssignment) => void;
  selectedCount: number;
  busy: boolean;
  onReview: () => void;
}) {
  const providerByPlatform = useMemo(() => {
    const m: Partial<Record<Platform, BackfillPlatformReport>> = {};
    report?.platforms.forEach((p) => (m[p.platform] = p));
    return m;
  }, [report]);

  return (
    <div className="space-y-2 rounded-lg border border-border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted">2 · Review &amp; select ({selectedCount} selected)</span>
        <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover" onClick={() => bulk((r) => importable(r.c.classification as Cls) && isSuggested(r.c.classification as Cls), () => ({ selected: true }))}>Select all suggested Bootcamp</button>
        {ORDER.map((p) => (
          <button key={p} type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover" onClick={() => bulk((r) => r.platform === p && importable(r.c.classification as Cls), () => ({ selected: true }))}>Select all {PLATFORM_LABEL[p]}</button>
        ))}
        <button type="button" className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover" onClick={() => bulk(() => true, () => ({ selected: false }))}>Clear</button>
      </div>
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface px-2 py-1.5">
          <span className="font-medium">Set {selectedCount} selected →</span>
          <button type="button" onClick={() => assignSelected("bootcamp")} className="rounded border border-positive/50 px-2 py-0.5 text-positive hover:bg-surface-hover">Bootcamp</button>
          <button type="button" onClick={() => assignSelected("mtl")} className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover">MTL</button>
          <button type="button" onClick={() => assignSelected("unassigned")} className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover">Unassigned</button>
          <button type="button" onClick={() => assignSelected("exclude")} className="rounded border border-negative/50 px-2 py-0.5 text-negative hover:bg-surface-hover">Remove/Exclude</button>
          <button type="button" onClick={() => assignSelected("ignore")} className="rounded border border-border px-2 py-0.5 hover:bg-surface-hover">Ignore</button>
        </div>
      )}

      <div className="max-h-[460px] overflow-y-auto">
        {ORDER.filter((p) => rows.some((r) => r.platform === p)).map((p) => {
          const pr = providerByPlatform[p];
          return (
            <div key={p} className="mb-2">
              <div className="sticky top-0 bg-background py-1 text-[11px] font-semibold text-muted">
                {PLATFORM_LABEL[p]} · {pr?.provider ?? "?"} · {pr?.candidatesFound ?? 0} found {pr?.anchorFound ? "· anchor ✓" : ""}{" "}
                {pr?.estCostUsd != null ? `· $${pr.estCostUsd.toFixed(3)}` : ""}
              </div>
              {rows.filter((r) => r.platform === p).map((r) => (
                <RowItem key={r.id} r={r} setRow={setRow} />
              ))}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <button type="button" disabled={busy || selectedCount === 0} onClick={onReview} className="rounded-lg border border-accent/50 bg-accent/10 px-3 py-1.5 font-medium text-accent hover:bg-accent/20 disabled:opacity-50">
          3 · Review credit impact ({selectedCount})
        </button>
      </div>
    </div>
  );
}

function RowItem({ r, setRow }: { r: Row; setRow: (id: string, patch: Partial<Row>) => void }) {
  const cls = r.c.classification as Cls;
  const locked = !importable(cls);
  return (
    <div className={`flex items-start gap-2 border-b border-border/50 py-1.5 ${locked ? "opacity-50" : ""}`}>
      <input type="checkbox" className="mt-1" checked={r.selected} disabled={locked} onChange={(e) => setRow(r.id, { selected: e.target.checked })} aria-label="select" />
      {r.c.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={r.c.thumbnailUrl} alt="" className="h-11 w-8 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-11 w-8 shrink-0 rounded bg-surface" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{r.c.title ?? r.c.caption ?? r.c.canonicalUrl ?? "(untitled)"}</div>
        <div className="flex flex-wrap gap-x-2 text-[10px] text-muted-strong">
          <span>{r.c.publishedAt ? r.c.publishedAt.slice(0, 10) : "no date"}</span>
          {r.c.views != null && <span>{r.c.views.toLocaleString("en-US")} views</span>}
          <span className={isSuggested(cls) ? "text-positive" : "text-muted"}>{CANDIDATE_CLASS_LABEL[cls]}</span>
          {r.c.existingVideoId && <span className="text-warning">already tracked</span>}
          {r.c.canonicalUrl && (
            <a href={r.c.canonicalUrl} target="_blank" rel="noopener noreferrer" className="truncate text-accent hover:underline">link</a>
          )}
        </div>
      </div>
      <select
        value={r.assign}
        disabled={locked}
        onChange={(e) => setRow(r.id, { assign: e.target.value as ImportAssignment })}
        className="shrink-0 rounded border border-border bg-surface px-1 py-0.5 text-[11px]"
        aria-label="assignment"
      >
        <option value="bootcamp">Bootcamp</option>
        <option value="mtl">MTL</option>
        <option value="unassigned">Unassigned</option>
        <option value="exclude">Remove</option>
        <option value="ignore">Ignore</option>
      </select>
    </div>
  );
}

function CreditConfirm({ preview, busy, onImport }: { preview: PreviewData; busy: boolean; onImport: () => void }) {
  const a = preview.byAssignment;
  return (
    <div className="space-y-2 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">4 · Confirm credit &amp; campaign impact</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span>selected <b>{preview.selected}</b></span>
        <span className="text-positive">Bootcamp {a.bootcamp ?? 0}</span>
        <span>MTL {a.mtl ?? 0}</span>
        <span>Unassigned {a.unassigned ?? 0}</span>
        <span className="text-negative">Remove {a.exclude ?? 0}</span>
        <span>Ignore {a.ignore ?? 0}</span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span>est. initial-metrics credits <b>{preview.estInitialMetricsCredits}</b></span>
        <span>Apify spend <b>$0</b></span>
        <span>est. Bootcamp daily refresh ~{preview.estBootcampDailyRefreshCost}/day</span>
        <span>used today {preview.usedToday}/{preview.cap}</span>
        <span>headroom {preview.headroom}</span>
        {preview.remaining != null && <span>balance {preview.remaining.toLocaleString("en-US")}</span>}
        {preview.estDaysRemaining != null && <span>~{preview.estDaysRemaining}d left</span>}
      </div>
      <div className={`rounded border px-2 py-1 text-[11px] ${preview.fitsUnderCap ? "border-positive/40 text-positive" : "border-warning/50 text-warning"}`}>
        {preview.fitsUnderCap
          ? `Initial metrics fit under today's cap. Records create immediately.`
          : `${preview.pendingIfImportedNow} video(s) will be created with metrics PENDING (cap nearly reached) — the daily Bootcamp tier fetches them within ~24h. Records still create now.`}
      </div>
      <button type="button" disabled={busy} onClick={onImport} className="rounded-lg border border-positive/50 bg-positive/10 px-3 py-1.5 font-medium text-positive hover:bg-positive/20 disabled:opacity-50">
        5 · Import {preview.selected} selected
      </button>
    </div>
  );
}

function ImportResultView({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-2 rounded-lg border border-positive/40 bg-positive/5 p-3">
      <div className="text-[12px] font-semibold uppercase tracking-wide text-muted">6 · Import result</div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span className="text-positive">created <b>{result.created}</b></span>
        <span>updated {result.updated}</span>
        <span>skipped {result.skipped}</span>
        <span className="text-negative">excluded {result.excluded}</span>
        <span>Bootcamp {result.assignedBootcamp}</span>
        <span>MTL {result.assignedMtl}</span>
        <span>Unassigned {result.assignedUnassigned}</span>
        <span>pending metrics {result.pendingMetrics}</span>
        <span>credits used {result.creditsUsed}</span>
      </div>
      {Object.keys(result.skippedReasons).length > 0 && (
        <div className="text-[10px] text-muted-strong">skipped: {Object.entries(result.skippedReasons).map(([k, v]) => `${k}=${v}`).join(" · ")}</div>
      )}
      {result.errors.length > 0 && <div className="text-[10px] text-negative">errors: {result.errors.slice(0, 5).join(" · ")}</div>}
      <div className="text-[10px] text-muted-strong">Bootcamp videos refresh once per day; pending metrics are fetched by the daily tier within ~24h, under the cap.</div>
    </div>
  );
}

function mergeReports(platforms: BackfillPlatformReport[], last: BackfillDryRunReport): BackfillDryRunReport {
  const cls = (c: Cls) => platforms.reduce((s, p) => s + (p.byClass[c] ?? 0), 0);
  const costs = platforms.map((p) => p.estCostUsd).filter((c): c is number => c !== null);
  return {
    generatedAt: last.generatedAt, enabled: last.enabled, provider: last.provider, startDate: last.startDate,
    platforms,
    totals: {
      candidatesFound: platforms.reduce((s, p) => s + p.candidatesFound, 0),
      importable: (["suggested_bootcamp", "overlap", "invalid_date"] as Cls[]).reduce((s, c) => s + cls(c), 0),
      suggestedBootcamp: cls("suggested_bootcamp") + cls("suggested_bootcamp_unresolved"),
      overlap: cls("overlap"),
      alreadyMtl: cls("already_mtl"),
      alreadyBootcamp: cls("already_bootcamp"),
      alreadyExcluded: cls("already_excluded"),
      invalid: cls("invalid_url") + cls("invalid_date"),
      providerCalls: platforms.filter((p) => p.ran).length,
      estCostUsd: costs.length ? Math.round(costs.reduce((s, c) => s + c, 0) * 10000) / 10000 : null,
    },
    maxProviderCalls: last.maxProviderCalls, maxCostUsd: last.maxCostUsd, wroteRecords: false,
  };
}
