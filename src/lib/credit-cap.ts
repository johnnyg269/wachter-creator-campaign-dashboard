// Today-only SocialCrawl credit-cap override (schema-free). Stored as a single
// ManualOverride "config" row — NO DB migration, NO permanent env change. An
// admin can temporarily raise today's cap (e.g. 350 → 600) to fill pending
// metrics; it auto-expires at the next ET midnight, after which the resolved cap
// falls back to the env default (SOCIALCRAWL_DAILY_CREDIT_CAP, normally 350).
//
//   active override (now < expiresAt)  → override value
//   missing / invalid / expired        → env default
//
// Admin-only (callers gate); never exposes secrets/internals.

import { getSocialcrawlDailyCreditCap } from "./config";
import { etMidnightMs } from "./eligibility";
import { localDateKey } from "./refresh-policy";
import type { Store } from "./store/types";

const TZ = "America/New_York";
const CAP_ENTITY_TYPE = "config" as const;
const CAP_ENTITY_ID = "socialcrawl_credit_cap";
const CAP_FIELD = "daily_cap_override";

export interface CapOverride {
  value: number;
  effectiveDateEt: string; // YYYY-MM-DD (ET)
  expiresAtIso: string; // next ET midnight
  createdAtIso: string;
  createdBy: string; // admin action marker (no PII)
  reason: string;
}

export interface ResolvedCap {
  activeCap: number;
  baseCap: number;
  override: CapOverride | null;
}

/** Next ET-midnight (end of today's ET day) as an ISO string. */
export function nextEtMidnightIso(now: Date): string {
  const todayEt = localDateKey(now, TZ); // YYYY-MM-DD in ET
  const [y, m, d] = todayEt.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1)); // handles month/year rollover
  const ymd = tomorrow.toISOString().slice(0, 10);
  return new Date(etMidnightMs(ymd)).toISOString();
}

/**
 * Set a today-only cap override (expires at the next ET midnight). Stored as a
 * config ManualOverride row; the newest such row wins. Returns the override.
 */
export async function setCapOverride(
  store: Store,
  args: { value: number; reason?: string; createdBy?: string; now?: Date },
): Promise<CapOverride> {
  const now = args.now ?? new Date();
  const override: CapOverride = {
    value: Math.floor(args.value),
    effectiveDateEt: localDateKey(now, TZ),
    expiresAtIso: nextEtMidnightIso(now),
    createdAtIso: now.toISOString(),
    createdBy: args.createdBy ?? "admin",
    reason: args.reason ?? "today-only credit-cap override",
  };
  await store.addOverride({
    entityType: CAP_ENTITY_TYPE,
    entityId: CAP_ENTITY_ID,
    field: CAP_FIELD,
    oldValue: String(getSocialcrawlDailyCreditCap()),
    newValue: JSON.stringify(override),
    reason: override.reason,
  });
  return override;
}

/** The active (un-expired) cap override, or null. Tolerant of bad/old rows. */
export async function getActiveCapOverride(store: Store, now: Date = new Date()): Promise<CapOverride | null> {
  // Parse every valid cap-override row, then take the newest by the override's
  // own createdAtIso (caller-stamped — reliable even when several rows share the
  // store's millisecond createdAt). The newest decides: if it's expired, there
  // is no active override.
  const valid: CapOverride[] = [];
  for (const r of await store.listOverrides(500)) {
    if (r.entityType !== CAP_ENTITY_TYPE || r.entityId !== CAP_ENTITY_ID || r.field !== CAP_FIELD || !r.newValue) continue;
    let parsed: Partial<CapOverride> | null = null;
    try {
      parsed = JSON.parse(r.newValue) as Partial<CapOverride>;
    } catch {
      continue;
    }
    const value = Number(parsed?.value);
    if (!Number.isFinite(value) || value <= 0 || typeof parsed?.expiresAtIso !== "string" || Number.isNaN(Date.parse(parsed.expiresAtIso))) continue;
    valid.push({
      value: Math.floor(value),
      effectiveDateEt: parsed.effectiveDateEt ?? localDateKey(now, TZ),
      expiresAtIso: parsed.expiresAtIso,
      createdAtIso: parsed.createdAtIso ?? r.createdAt,
      createdBy: parsed.createdBy ?? "admin",
      reason: parsed.reason ?? r.reason ?? "",
    });
  }
  if (valid.length === 0) return null;
  valid.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso)); // newest first
  const newest = valid[0];
  return now.getTime() >= Date.parse(newest.expiresAtIso) ? null : newest;
}

/**
 * Resolve the effective SocialCrawl daily cap: the active override value when
 * present + un-expired, otherwise the env default. Used by the credit policy,
 * the catch-up, and the admin panel so all read one consistent value.
 */
export async function resolveCreditCap(store: Store, now: Date = new Date()): Promise<ResolvedCap> {
  const baseCap = getSocialcrawlDailyCreditCap();
  const override = await getActiveCapOverride(store, now);
  return { activeCap: override ? override.value : baseCap, baseCap, override };
}
