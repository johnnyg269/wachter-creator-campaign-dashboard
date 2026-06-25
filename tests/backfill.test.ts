// One-time Bootcamp BACKFILL discovery (Phase 2B): config + caps, actor
// resolution, the disabled-by-default safety (no provider calls), and an Apify
// integration (mocked fetch) proving it enumerates + classifies + dedups against
// existing records and NEVER writes. Ongoing-Apify kill switch stays untouched.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBackfillConfig } from "@/lib/config";
import { backfillActorId, runBackfillDryRun } from "@/lib/backfill";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// ── Config + caps ─────────────────────────────────────────────────────────────
describe("getBackfillConfig", () => {
  const KEYS = ["BACKFILL_DISCOVERY_ENABLED", "BACKFILL_DISCOVERY_PROVIDER", "BACKFILL_MAX_PROVIDER_CALLS", "BACKFILL_MAX_COST_USD", "BACKFILL_START_DATE", "BOOTCAMP_START_DATE"];
  let restore: () => void;
  afterEach(() => restore?.());
  it("is DISABLED by default with provider none + spec caps + April floor", () => {
    restore = stashEnv(KEYS);
    expect(getBackfillConfig()).toEqual({
      enabled: false,
      provider: "none",
      maxProviderCalls: 10,
      maxCostUsd: 5,
      startDate: "2026-04-11",
    });
  });
  it("honors explicit env overrides", () => {
    restore = stashEnv(KEYS);
    process.env.BACKFILL_DISCOVERY_ENABLED = "true";
    process.env.BACKFILL_DISCOVERY_PROVIDER = "apify";
    process.env.BACKFILL_MAX_PROVIDER_CALLS = "6";
    process.env.BACKFILL_MAX_COST_USD = "3";
    process.env.BACKFILL_START_DATE = "2026-04-15";
    expect(getBackfillConfig()).toEqual({ enabled: true, provider: "apify", maxProviderCalls: 6, maxCostUsd: 3, startDate: "2026-04-15" });
  });
  it("provider only accepts none|apify (junk → none)", () => {
    restore = stashEnv(KEYS);
    process.env.BACKFILL_DISCOVERY_PROVIDER = "sketchy";
    expect(getBackfillConfig().provider).toBe("none");
  });
});

describe("backfillActorId", () => {
  const KEYS = ["APIFY_TIKTOK_ACTOR_ID", "APIFY_INSTAGRAM_ACTOR_ID", "APIFY_FACEBOOK_ACTOR_ID"];
  let restore: () => void;
  afterEach(() => restore?.());
  it("maps TT/IG/FB to the verified candidate actors; YouTube → null (Data API)", () => {
    restore = stashEnv(KEYS);
    expect(backfillActorId("tiktok")).toBe("GdWCkxBtKWOsKjdch");
    expect(backfillActorId("instagram")).toBe("xMc5Ga1oCONPmWJIa");
    expect(backfillActorId("facebook")).toBe("KoJrdxJCTtpon81KY");
    expect(backfillActorId("youtube")).toBeNull();
  });
  it("env override wins", () => {
    restore = stashEnv(KEYS);
    process.env.APIFY_TIKTOK_ACTOR_ID = "CustomActor123";
    expect(backfillActorId("tiktok")).toBe("CustomActor123");
  });
});

// ── Integration ───────────────────────────────────────────────────────────────
const CFG = { enabled: true, provider: "apify" as const, maxProviderCalls: 10, maxCostUsd: 5, startDate: "2026-04-11" };
const TT_ACTOR = "GdWCkxBtKWOsKjdch";

const ttItem = (id: string, dateIso: string, views: number) => ({
  id,
  webVideoUrl: `https://www.tiktok.com/@cybernick0x/video/${id}`,
  createTimeISO: dateIso,
  text: `video ${id}`,
  playCount: views,
  diggCount: 10,
  commentCount: 2,
  shareCount: 1,
});

describe("runBackfillDryRun — enumerate + classify + NEVER write", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    process.env.CAMPAIGN_START_DATE_ET = "2026-06-08";
    process.env.APIFY_TOKEN = "apify_test";
    delete process.env.YOUTUBE_API_KEY; // YouTube → not_configured (no fetch)
  });
  afterEach(async () => {
    reset();
    delete process.env.CAMPAIGN_START_DATE_ET;
    delete process.env.APIFY_TOKEN;
    vi.unstubAllGlobals();
    await tmp.cleanup();
  });

  it("disabled config performs ZERO provider calls and writes nothing", async () => {
    const store = getStore();
    await ensureSeedData(store);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const countBefore = (await store.listVideos({ includeHidden: true })).length;
    const report = await runBackfillDryRun(store, { ...CFG, enabled: false, provider: "none" });
    expect(fetchSpy).not.toHaveBeenCalled(); // no Apify, no YouTube
    expect(report.wroteRecords).toBe(false);
    expect((await store.listVideos({ includeHidden: true })).length).toBe(countBefore);
    expect(report.platforms.every((p) => !p.ran)).toBe(true);
  });

  it("Apify lane: enumerates TikTok, classifies (already-MTL not overwritten, anchor found), writes nothing", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    // Existing MTL video that one enumerated item matches → must classify already_mtl.
    await store.insertVideo({
      campaignId: campaign.id, platform: "tiktok", profileId: null,
      originalUrl: "https://www.tiktok.com/@cybernick0x/video/111", externalVideoId: "111",
      title: "existing", caption: null, thumbnailUrl: null,
      publishedAt: "2026-06-10T00:00:00.000Z", firstTrackedAt: "2026-06-10T00:00:00.000Z",
      lastRefreshedAt: null, status: "active", episodeGroupId: null, sourceStatus: "live",
      errorMessage: null, hidden: false, isSeed: false, rawJson: { campaign: "mtl" } as never,
    });
    const countBefore = (await store.listVideos({ includeHidden: true })).length;

    let ttCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        let body: unknown = [];
        if (u.includes("/runs?desc")) body = { data: { items: [{ usageTotalUsd: 0.2 }] } };
        else if (u.includes(`/acts/${TT_ACTOR}/run-sync-get-dataset-items`)) {
          ttCalls++;
          body = [
            ttItem("111", "2026-06-10T00:00:00.000Z", 1000), // already MTL
            ttItem("222", "2026-04-20T00:00:00.000Z", 5000), // new, pre-MTL → suggested bootcamp
            ttItem("7627682544586083614", "2026-04-12T00:00:00.000Z", 23000), // anchor → suggested bootcamp
          ];
        } else if (u.includes("run-sync-get-dataset-items")) body = []; // IG/FB empty
        return { ok: true, status: 201, json: async () => body } as unknown as Response;
      }),
    );

    const report = await runBackfillDryRun(store, CFG);

    // NOTHING written.
    expect(report.wroteRecords).toBe(false);
    expect((await store.listVideos({ includeHidden: true })).length).toBe(countBefore);
    expect(ttCalls).toBe(1); // one actor run for TikTok

    const tt = report.platforms.find((p) => p.platform === "tiktok")!;
    expect(tt.ran).toBe(true);
    expect(tt.candidatesFound).toBe(3);
    expect(tt.byClass.already_mtl).toBe(1); // existing MTL preserved, not overwritten
    expect(tt.byClass.suggested_bootcamp).toBe(2);
    expect(tt.anchorFound).toBe(true);
    expect(tt.canPaginate).toBe(true);
    expect(tt.estCostUsd).toBe(0.2);
    expect(report.totals.suggestedBootcamp).toBe(2);
    expect(report.totals.alreadyMtl).toBe(1);

    // YouTube was skipped (no API key) — not_configured, no write.
    const yt = report.platforms.find((p) => p.platform === "youtube")!;
    expect(yt.ran).toBe(false);
    expect(yt.stopReason).toBe("not_configured");
  });

  it("respects the provider-call cap (0 calls → nothing runs)", async () => {
    const store = getStore();
    await ensureSeedData(store);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const report = await runBackfillDryRun(store, { ...CFG, maxProviderCalls: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.platforms.every((p) => p.stopReason === "max_calls" || p.stopReason === "not_configured")).toBe(true);
  });

  it("runs ONE platform per call when scoped (avoids the Apify concurrency limit)", async () => {
    const store = getStore();
    await ensureSeedData(store);
    let ttCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        let body: unknown = [];
        if (u.includes("/runs?desc")) body = { data: { items: [{ usageTotalUsd: 0.2 }] } };
        else if (u.includes(`/acts/${TT_ACTOR}/run-sync-get-dataset-items`)) {
          ttCalls++;
          body = [ttItem("900", "2026-05-01T00:00:00.000Z", 4000)];
        } else if (u.includes("run-sync-get-dataset-items")) {
          throw new Error("no other platform should be called");
        }
        return { ok: true, status: 201, json: async () => body } as unknown as Response;
      }),
    );
    const report = await runBackfillDryRun(store, CFG, { platforms: ["tiktok"] });
    expect(report.platforms.map((p) => p.platform)).toEqual(["tiktok"]); // ONLY tiktok
    expect(ttCalls).toBe(1);
    expect(report.platforms[0].byClass.suggested_bootcamp).toBe(1);
  });

  it("PRE-SPEND cost guard aborts before any provider call when the estimate exceeds the cap", async () => {
    const store = getStore();
    await ensureSeedData(store);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    // 3 Apify platforms × ~$1 worst-case = ~$3 > $1 cap → abort, zero spend.
    const report = await runBackfillDryRun(store, { ...CFG, maxCostUsd: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(report.totals.providerCalls).toBe(0);
    expect(report.platforms.every((p) => p.stopReason === "max_cost" && !p.ran)).toBe(true);
  });
});

// ── Safety / source-level ─────────────────────────────────────────────────────
describe("backfill safety", () => {
  it("the dry-run route uses the shared fail-closed guard + clamps the date floor, no query secret", () => {
    const src = read("src/app/api/admin/bootcamp-backfill/dry-run/route.ts");
    expect(src).toMatch(/isAdminOrCronBearer\(req\)/);
    // HARD floor: a request may only tighten the window, never push it earlier.
    expect(src).toMatch(/reqStart < floor \? floor : reqStart/);
    expect(src).toMatch(/getBootcampStartDateEt\(\)/);
    expect(src).not.toMatch(/\?secret=/);
  });
  it("Apify only runs on EXPLICIT opt-in (confirm/provider) — never implicitly, never on cron", () => {
    const src = read("src/app/api/admin/bootcamp-backfill/dry-run/route.ts");
    expect(src).toMatch(/confirm === true \|\| body\.enable === true/);
    expect(src).toMatch(/provider === "apify"/);
    expect(src).not.toMatch(/maxDuration = 0/);
  });
  it("backfill is SEPARATE from the ongoing-Apify kill switch (does not touch it)", () => {
    const src = read("src/lib/backfill.ts");
    // Backfill must NOT consult the ongoing fallback gate or the per-run gate.
    expect(src).not.toMatch(/apifyFallbackAllowedByConfig|apifyAllowedNow|isApifyFallbackEnabled/);
    // It enumerates via the actor run endpoint directly, gated by its own caps.
    expect(src).toMatch(/run-sync-get-dataset-items/);
    expect(src).toMatch(/maxProviderCalls/);
  });
  it("ongoing refresh still never auto-calls Apify (kill switch intact)", () => {
    const cfg = read("src/lib/config.ts");
    expect(cfg).toMatch(/apifyFallbackAllowedByConfig/);
    const refresh = read("src/lib/refresh.ts");
    expect(refresh).toMatch(/apifyAllowedNow/); // ongoing gate unchanged
  });
});
