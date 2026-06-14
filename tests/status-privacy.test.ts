// Regression guard for the /api/status privacy fix (24h audit, 2026-06-14):
// the public, unauthenticated health endpoint once echoed the full health
// summary, which leaked the Apify actor ids and the data vendor
// (providerType: "apify"). toPublicHealth() is the pure projection the route
// now serializes — it must NEVER carry actor ids, vendor names, free-text
// status detail, or raw run logs. Node test env → behavioral + source guard.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { toPublicHealth, type HealthSummary } from "@/lib/queries";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// A health summary that DELIBERATELY carries every internal/vendor field a
// real getHealth() could produce, so we prove the projection strips them.
const ACTOR_ID = "GdWCkxBtKWOsKjdch";
const dirtyHealth = {
  store: { kind: "postgres", label: "Supabase" },
  mockMode: false,
  anyLive: true,
  platforms: [
    {
      platform: "tiktok",
      providerType: "apify",
      sourceStatus: "live",
      statusDetail: "Apify token connected — actor " + ACTOR_ID,
      lastSuccessfulRefreshAt: "2026-06-14T15:00:00.000Z",
      supportsComments: true,
      supportsDiscovery: true,
    },
    {
      platform: "youtube",
      providerType: "youtube_api",
      sourceStatus: "live",
      statusDetail: null,
      lastSuccessfulRefreshAt: "2026-06-14T15:00:01.000Z",
      supportsComments: true,
      supportsDiscovery: true,
    },
  ],
  lastRun: {
    id: "run_1",
    status: "success",
    trigger: "cron",
    startedAt: "2026-06-14T15:00:10.000Z",
    finishedAt: "2026-06-14T15:01:00.000Z",
    rawLog: ["mode:full discovery:off comments:off", `tiktok: apify actor ${ACTOR_ID} ran`],
  },
} as unknown as HealthSummary;

describe("toPublicHealth strips vendor + actor internals", () => {
  const pub = toPublicHealth(dirtyHealth);
  const serialized = JSON.stringify(pub);

  it("never leaks the Apify actor id", () => {
    expect(serialized).not.toContain(ACTOR_ID);
  });
  it("never leaks the data vendor (providerType / 'apify')", () => {
    expect(serialized).not.toContain("providerType");
    expect(serialized.toLowerCase()).not.toContain("apify");
  });
  it("drops free-text statusDetail and raw run logs", () => {
    expect(serialized).not.toContain("statusDetail");
    expect(serialized).not.toContain("rawLog");
    expect(serialized).not.toContain("mode:full");
    expect(serialized).not.toContain("trigger");
  });
  it("keeps the badge-relevant, non-sensitive fields", () => {
    expect(pub.anyLive).toBe(true);
    expect(pub.store.kind).toBe("postgres");
    expect(pub.platforms.map((p) => p.platform)).toEqual(["tiktok", "youtube"]);
    expect(pub.platforms[0].sourceStatus).toBe("live");
    expect(pub.platforms[0].lastSuccessfulRefreshAt).toBe("2026-06-14T15:00:00.000Z");
    expect(pub.platforms[0].supportsComments).toBe(true);
    expect(pub.lastRun?.status).toBe("success");
    // exact public key set — no extra keys can sneak back in
    expect(Object.keys(pub.platforms[0]).sort()).toEqual([
      "lastSuccessfulRefreshAt",
      "platform",
      "sourceStatus",
      "supportsComments",
      "supportsDiscovery",
    ]);
  });
});

describe("the /api/status route serializes only the public projection", () => {
  const route = read("src/app/api/status/route.ts");
  it("uses toPublicHealth and never the raw health object", () => {
    expect(route).toContain("toPublicHealth");
    // must not hand the raw summary straight to the response
    expect(route).not.toMatch(/health:\s*health\b/);
    expect(route).not.toContain("providerType");
    expect(route).not.toContain("actorId");
  });
});

describe("PlatformHealth no longer carries an actor id at the type level", () => {
  const queries = read("src/lib/queries.ts");
  it("the actorId field was removed from the shared health type", () => {
    // the interface block for PlatformHealth must not declare actorId
    const ifaceStart = queries.indexOf("export interface PlatformHealth");
    const ifaceEnd = queries.indexOf("}", ifaceStart);
    const iface = queries.slice(ifaceStart, ifaceEnd);
    expect(iface).not.toContain("actorId");
  });
});
