// Row Level Security maintenance for the Postgres (Supabase) backend.
//
// WHY THIS EXISTS: Supabase auto-exposes every `public` table through its
// PostgREST Data API, reachable from the browser with the project's public
// `anon` key. If a table has RLS disabled, anyone with that key can read (and
// depending on grants, write) it directly — bypassing the app entirely. The
// Supabase advisor flags exactly this ("RLS not enabled on a public table").
//
// This app never uses the Supabase Data API — it talks to Postgres ONLY
// server-side via Prisma over a direct connection. So the correct fix is
// deny-by-default: enable RLS on every public table and add NO anon/authenticated
// policies, plus revoke their table grants as defense-in-depth. Prisma connects
// as the table-owning role, which BYPASSES RLS (we never use FORCE), so every
// server job keeps full access after the change.
//
// SAFETY: applyRls refuses to run unless the connected role provably bypasses
// RLS (owner / superuser / BYPASSRLS) for the tables — so it can never lock the
// app out of its own database. Read-only introspection has no such guard.

import type { PrismaClient } from "@prisma/client";

// ── Pure helpers (no DB) ─────────────────────────────────────────────────────

/** Postgres identifiers we will ever quote come from pg_catalog, but validate
 *  defensively so a hostile name can never break out of the quotes. */
export function isSafeIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) && name.length <= 63;
}

/** Double-quote a validated identifier (throws on anything unsafe). */
export function quoteIdent(name: string): string {
  if (!isSafeIdentifier(name)) throw new Error(`unsafe identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export function enableRlsSql(table: string): string {
  return `ALTER TABLE "public".${quoteIdent(table)} ENABLE ROW LEVEL SECURITY`;
}

export function revokeGrantsSql(table: string, roles: string[]): string {
  const list = roles.map(quoteIdent).join(", ");
  return `REVOKE ALL ON "public".${quoteIdent(table)} FROM ${list}`;
}

export interface RoleInfo {
  currentUser: string;
  isSuper: boolean;
  bypassRls: boolean;
}

/** True when the connected role keeps full access to `owner`'s tables even after
 *  RLS is enabled (so enabling RLS can never lock the app out). A non-FORCE table
 *  is bypassed by its owner, any superuser, and any BYPASSRLS role. */
export function roleBypassesRls(role: RoleInfo, tableOwner: string): boolean {
  return role.isSuper || role.bypassRls || role.currentUser === tableOwner;
}

// ── DB types ─────────────────────────────────────────────────────────────────

export interface TableRls {
  table: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  owner: string;
}
export interface GrantRow {
  table: string;
  grantee: string;
  privileges: string[];
}
export interface RlsAudit {
  role: RoleInfo;
  tables: TableRls[];
  /** anon / authenticated / service_role table grants in public. */
  grants: GrantRow[];
  policies: Array<{ table: string; policy: string; roles: string; cmd: string }>;
  /** public tables with RLS currently DISABLED (what the advisor flags). */
  tablesWithoutRls: string[];
  /** tables where anon or authenticated currently hold ANY privilege. */
  tablesAnonReachable: string[];
  /** whether it is safe to enable RLS without locking the app out. */
  safeToEnable: boolean;
  safeToEnableReason: string;
}

type Raw = Record<string, unknown>;
const q = <T = Raw>(p: PrismaClient, sql: string) => p.$queryRawUnsafe<T[]>(sql);

async function readRole(prisma: PrismaClient): Promise<RoleInfo> {
  const rows = await q(prisma, `SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b FROM pg_roles r WHERE r.rolname = current_user`);
  const row = rows[0] ?? {};
  return {
    currentUser: String((row as Raw).u ?? ""),
    isSuper: Boolean((row as Raw).s),
    bypassRls: Boolean((row as Raw).b),
  };
}

async function readTables(prisma: PrismaClient): Promise<TableRls[]> {
  const rows = await q(
    prisma,
    `SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return rows.map((r) => ({
    table: String((r as Raw).t),
    rlsEnabled: Boolean((r as Raw).rls),
    rlsForced: Boolean((r as Raw).forced),
    owner: String((r as Raw).owner),
  }));
}

async function readGrants(prisma: PrismaClient): Promise<GrantRow[]> {
  const rows = await q(
    prisma,
    `SELECT table_name AS t, grantee AS g, privilege_type AS p
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee IN ('anon','authenticated','service_role')
      ORDER BY table_name, grantee, privilege_type`,
  );
  const byKey = new Map<string, GrantRow>();
  for (const r of rows) {
    const table = String((r as Raw).t);
    const grantee = String((r as Raw).g);
    const key = `${table}::${grantee}`;
    const g = byKey.get(key) ?? { table, grantee, privileges: [] };
    g.privileges.push(String((r as Raw).p));
    byKey.set(key, g);
  }
  return [...byKey.values()];
}

async function readPolicies(prisma: PrismaClient): Promise<RlsAudit["policies"]> {
  const rows = await q(
    prisma,
    `SELECT tablename AS t, policyname AS p, roles::text AS roles, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
  );
  return rows.map((r) => ({ table: String((r as Raw).t), policy: String((r as Raw).p), roles: String((r as Raw).roles), cmd: String((r as Raw).cmd) }));
}

/** Read-only snapshot of RLS + grants for every public table. No mutations. */
export async function auditRls(prisma: PrismaClient): Promise<RlsAudit> {
  const [role, tables, grants, policies] = await Promise.all([
    readRole(prisma),
    readTables(prisma),
    readGrants(prisma),
    readPolicies(prisma),
  ]);
  const tablesWithoutRls = tables.filter((t) => !t.rlsEnabled).map((t) => t.table);
  const tablesAnonReachable = [
    ...new Set(grants.filter((g) => g.grantee === "anon" || g.grantee === "authenticated").map((g) => g.table)),
  ].sort();
  // Safe iff the connected role bypasses RLS for EVERY table it would enable it on.
  const unsafe = tables.find((t) => !roleBypassesRls(role, t.owner));
  const safeToEnable = !unsafe;
  return {
    role,
    tables,
    grants,
    policies,
    tablesWithoutRls,
    tablesAnonReachable,
    safeToEnable,
    safeToEnableReason: safeToEnable
      ? `connected role "${role.currentUser}" bypasses RLS (super=${role.isSuper}, bypassrls=${role.bypassRls}, owns all public tables) → enabling RLS cannot lock the app out`
      : `connected role "${role.currentUser}" would be subject to RLS on "${unsafe!.table}" (owner "${unsafe!.owner}") — refusing to enable to avoid locking the app out`,
  };
}

// ── Anon access probe (real, in-database) ────────────────────────────────────

export interface AnonProbeRow {
  op: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  denied: boolean;
  detail: string;
}

function isPermissionError(msg: string): boolean {
  return /permission denied|row-level security|must be owner|not allowed/i.test(msg);
}

/**
 * Genuine anon access test: assume the PostgREST `anon` role inside a transaction
 * that is ALWAYS rolled back, and attempt each CRUD op on `table`. This exercises
 * the exact role an unauthenticated browser request runs as via the Supabase Data
 * API — proving denial without needing the project's anon key. Never commits: the
 * transaction is forced to roll back even in the (impossible-after-fix) case an op
 * succeeds, so no data is ever mutated.
 */
export async function anonAccessProbe(prisma: PrismaClient, table: string): Promise<AnonProbeRow[]> {
  const t = `"public".${quoteIdent(table)}`;
  const ops: Array<{ op: AnonProbeRow["op"]; sql: string }> = [
    { op: "SELECT", sql: `SELECT count(*) FROM ${t}` },
    { op: "INSERT", sql: `INSERT INTO ${t} DEFAULT VALUES` },
    { op: "UPDATE", sql: `UPDATE ${t} SET "id" = "id"` },
    { op: "DELETE", sql: `DELETE FROM ${t}` },
  ];
  const ROLLBACK = "__rls_probe_rollback__";
  const results: AnonProbeRow[] = [];
  for (const { op, sql } of ops) {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE anon`);
        await tx.$executeRawUnsafe(sql);
        throw new Error(ROLLBACK); // op did NOT error → permission allowed; undo it
      });
      results.push({ op, denied: false, detail: "unexpected: transaction committed" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes(ROLLBACK)) {
        results.push({ op, denied: false, detail: "ALLOWED (rolled back — anon could perform this)" });
      } else if (isPermissionError(msg)) {
        results.push({ op, denied: true, detail: msg.split("\n")[0].slice(0, 160) });
      } else {
        // reached execution but failed for another reason → permission was NOT denied
        results.push({ op, denied: false, detail: `not a permission block: ${msg.split("\n")[0].slice(0, 140)}` });
      }
    }
  }
  return results;
}

/** User-defined functions in `public` (PostgREST would expose these as RPC). */
export async function publicFunctions(prisma: PrismaClient): Promise<string[]> {
  const rows = await q(
    prisma,
    `SELECT p.proname AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = 'public' ORDER BY p.proname`,
  );
  return rows.map((r) => String((r as Raw).n));
}

export interface RlsFixResult {
  before: RlsAudit;
  applied: boolean;
  enabledRls: string[];
  revokedFrom: Array<{ table: string; roles: string[] }>;
  skippedReason: string | null;
  after: RlsAudit | null;
}

/**
 * Enable RLS (deny-by-default, NOT forced) on every public table that lacks it,
 * and revoke anon/authenticated table grants. Idempotent. Refuses to run unless
 * the connected role provably bypasses RLS (so the app is never locked out).
 */
export async function applyRls(
  prisma: PrismaClient,
  opts: { revokeGrants?: boolean } = {},
): Promise<RlsFixResult> {
  const revoke = opts.revokeGrants ?? true;
  const before = await auditRls(prisma);
  if (!before.safeToEnable) {
    return { before, applied: false, enabledRls: [], revokedFrom: [], skippedReason: before.safeToEnableReason, after: null };
  }

  const enabledRls: string[] = [];
  for (const t of before.tables) {
    if (t.rlsEnabled) continue;
    await prisma.$executeRawUnsafe(enableRlsSql(t.table));
    enabledRls.push(t.table);
  }

  const revokedFrom: Array<{ table: string; roles: string[] }> = [];
  if (revoke) {
    // Only revoke from roles that actually exist (REVOKE errors on unknown roles).
    const roleRows = await q(prisma, `SELECT rolname AS r FROM pg_roles WHERE rolname IN ('anon','authenticated')`);
    const existing = roleRows.map((r) => String((r as Raw).r)).filter((r) => r === "anon" || r === "authenticated");
    if (existing.length > 0) {
      for (const t of before.tables) {
        const held = before.grants.some(
          (g) => g.table === t.table && (g.grantee === "anon" || g.grantee === "authenticated"),
        );
        if (!held) continue;
        await prisma.$executeRawUnsafe(revokeGrantsSql(t.table, existing));
        revokedFrom.push({ table: t.table, roles: existing });
      }
    }
  }

  const after = await auditRls(prisma);
  return { before, applied: true, enabledRls, revokedFrom, skippedReason: null, after };
}
