// Verifies graceful degradation: with NO credentials configured, providers
// report honest statuses, refresh skips every platform without crashing, and
// the seed campaign/profiles/videos are still created.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stashEnv, useTmpCwd, type TmpCwd } from "./helpers";

const ENV_KEYS = [
  "APIFY_TOKEN",
  "YOUTUBE_API_KEY",
  "MOCK_DATA",
  "DATABASE_URL",
  "APIFY_TIKTOK_ACTOR_ID",
  "APIFY_INSTAGRAM_ACTOR_ID",
  "APIFY_FACEBOOK_ACTOR_ID",
  "APIFY_YOUTUBE_ACTOR_ID",
];

let tmp: TmpCwd;
let restoreEnv: () => void;

beforeEach(async () => {
  tmp = await useTmpCwd();
  restoreEnv = stashEnv(ENV_KEYS);
  vi.resetModules();
  (globalThis as Record<string, unknown>).__wachterStore = undefined;
  (globalThis as Record<string, unknown>).__wachterRefreshing = undefined;
});

afterEach(async () => {
  restoreEnv();
  (globalThis as Record<string, unknown>).__wachterStore = undefined;
  await tmp.cleanup();
});

describe("providers without credentials", () => {
  it("report honest not-ready statuses", async () => {
    const { getStore } = await import("@/lib/store");
    const { resolveProvider } = await import("@/lib/providers/registry");
    const store = getStore();

    const tiktok = await resolveProvider("tiktok", store);
    expect(tiktok.readiness.ready).toBe(false);
    expect(tiktok.readiness.sourceStatus).toBe("needs_apify_token");

    const youtube = await resolveProvider("youtube", store);
    expect(youtube.readiness.ready).toBe(false);
    expect(youtube.readiness.sourceStatus).toBe("needs_api_key");
  });

  it("with a token but no actor, status is actor_not_configured", async () => {
    process.env.APIFY_TOKEN = "apify_api_test_not_real";
    vi.resetModules();
    const { getStore } = await import("@/lib/store");
    const { resolveProvider } = await import("@/lib/providers/registry");
    const r = await resolveProvider("instagram", getStore());
    expect(r.readiness.ready).toBe(false);
    expect(r.readiness.sourceStatus).toBe("actor_not_configured");
  });
});

describe("runRefresh without credentials", () => {
  it("completes, seeds the campaign, and skips all platforms", async () => {
    const { runRefresh } = await import("@/lib/refresh");
    const { getStore } = await import("@/lib/store");

    const report = await runRefresh("script");
    expect(report.platforms).toHaveLength(4);
    for (const p of report.platforms) {
      expect(p.status).toBe("skipped");
      expect(p.reason).toBeTruthy();
    }
    // nothing attempted → partial, but never a crash
    expect(report.status).toBe("partial");

    const store = getStore();
    expect(await store.getCampaign()).not.toBeNull();
    expect(await store.listProfiles()).toHaveLength(4);
    const videos = await store.listVideos({ includeHidden: true });
    expect(videos).toHaveLength(4);
    expect(videos.every((v) => v.isSeed)).toBe(true);
    // no fabricated data
    expect(await store.listAllSnapshots()).toHaveLength(0);

    const runs = await store.listRefreshRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].finishedAt).not.toBeNull();
  });
});
