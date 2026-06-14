// Reports — printable / screenshot-ready campaign reports. PUBLIC, read-only:
// no refresh controls, no mutation endpoints, no secrets, no actor IDs ever.
// The server fetches a range-aware, public-safe payload once; the studio (a
// client component) applies the remaining filters instantly and renders the
// 16:9 slide canvas, print, and presentation modes.

import { buildReportsData } from "@/lib/reports-data";
import { DEFAULT_FILTERS, type MetricFocus, type ReportType } from "@/lib/reports";
import type { TimeRange } from "@/lib/queries";
import type { Platform } from "@/lib/types";
import { PLATFORMS } from "@/lib/types";
import { ReportsStudio } from "./reports-studio";

export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

function parseRange(v: string | string[] | undefined): TimeRange {
  const s = one(v);
  return s === "24h" || s === "7d" || s === "30d" || s === "all" ? s : DEFAULT_FILTERS.range;
}
function parsePlatform(v: string | string[] | undefined): Platform | "all" {
  const s = one(v);
  return s && (PLATFORMS as string[]).includes(s) ? (s as Platform) : "all";
}
function parseMetric(v: string | string[] | undefined): MetricFocus {
  const s = one(v);
  return s === "views" || s === "engagement" || s === "comments" || s === "growth"
    ? s
    : DEFAULT_FILTERS.metric;
}
function parseType(v: string | string[] | undefined): ReportType {
  const s = one(v);
  return s === "executive" || s === "platforms" || s === "concepts" || s === "audience"
    ? s
    : DEFAULT_FILTERS.type;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const data = await buildReportsData(range);

  // Validate the concept id against real concepts; unknown → "all".
  const conceptParam = one(sp.concept);
  const conceptId =
    conceptParam && data.concepts.some((c) => c.id === conceptParam) ? conceptParam : "all";

  const initialFilters = {
    range,
    platform: parsePlatform(sp.platform),
    conceptId,
    metric: parseMetric(sp.metric),
    type: parseType(sp.type),
  };

  return <ReportsStudio data={data} initialFilters={initialFilters} />;
}
