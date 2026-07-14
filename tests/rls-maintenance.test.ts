// RLS maintenance — pure helpers: identifier safety (no SQL injection via table
// names), deny-by-default DDL generation, and the lock-out guard that refuses to
// enable RLS when the connected role would itself be subject to it.

import { describe, expect, it } from "vitest";
import {
  enableRlsSql,
  isSafeIdentifier,
  quoteIdent,
  revokeGrantsSql,
  roleBypassesRls,
  type RoleInfo,
} from "@/lib/rls-maintenance";

describe("identifier safety", () => {
  it("accepts real Prisma table names", () => {
    for (const t of ["Video", "MetricSnapshot", "Comment", "Campaign", "_prisma_migrations", "RefreshRun"]) {
      expect(isSafeIdentifier(t)).toBe(true);
    }
  });
  it("rejects injection / malformed identifiers", () => {
    for (const bad of ['Video"; DROP TABLE x;--', "a b", "table; DELETE", "", "1abc", "x".repeat(64), "a-b", "a.b"]) {
      expect(isSafeIdentifier(bad)).toBe(false);
    }
  });
  it("quoteIdent throws rather than emit an unsafe identifier", () => {
    expect(() => quoteIdent('x"; DROP')).toThrow();
    expect(quoteIdent("Video")).toBe('"Video"');
  });
});

describe("deny-by-default DDL", () => {
  it("enables RLS (never FORCE) on a schema-qualified, quoted table", () => {
    expect(enableRlsSql("Video")).toBe('ALTER TABLE "public"."Video" ENABLE ROW LEVEL SECURITY');
    expect(enableRlsSql("MetricSnapshot")).not.toMatch(/FORCE/); // owner must keep bypass
  });
  it("revokes ALL from the given roles only (service_role/postgres untouched)", () => {
    expect(revokeGrantsSql("Comment", ["anon", "authenticated"])).toBe(
      'REVOKE ALL ON "public"."Comment" FROM "anon", "authenticated"',
    );
    // never references service_role or postgres
    expect(revokeGrantsSql("Comment", ["anon", "authenticated"])).not.toMatch(/service_role|postgres/);
  });
  it("cannot be injected through a table name", () => {
    expect(() => enableRlsSql('Video"; DROP TABLE "Comment')).toThrow();
    expect(() => revokeGrantsSql("Video", ['anon"; DROP'])).toThrow();
  });
});

describe("lock-out guard (roleBypassesRls)", () => {
  const role = (over: Partial<RoleInfo>): RoleInfo => ({ currentUser: "postgres", isSuper: false, bypassRls: false, ...over });
  it("table owner bypasses RLS (the common Supabase+Prisma case) → safe", () => {
    expect(roleBypassesRls(role({ currentUser: "postgres" }), "postgres")).toBe(true);
  });
  it("superuser or BYPASSRLS role → safe regardless of owner", () => {
    expect(roleBypassesRls(role({ isSuper: true }), "someone_else")).toBe(true);
    expect(roleBypassesRls(role({ bypassRls: true }), "someone_else")).toBe(true);
  });
  it("a non-owner, non-super, non-bypass role → NOT safe (would lock the app out)", () => {
    expect(roleBypassesRls(role({ currentUser: "app_readwrite" }), "postgres")).toBe(false);
  });
});
