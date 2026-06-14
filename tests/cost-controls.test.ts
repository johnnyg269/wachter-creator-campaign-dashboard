// Cost-control add-on gating at the Apify input layer. Proves that:
//  - the TikTok comment add-on (commentsPerPost) is requested ONLY on a
//    comment-detail cycle (wantComments=true), never on metrics-only refreshes
//  - the Instagram share-count add-on is off unless ENABLE_INSTAGRAM_SHARES=1
// runActor is mocked so no real Apify calls are made and we can inspect the
// exact actor input that would have been sent.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured: Array<{ actorId: string; input: Record<string, unknown> }> = [];

vi.mock("@/lib/apify/client", () => ({
  runActor: vi.fn(async (opts: { actorId: string; input: Record<string, unknown> }) => {
    captured.push({ actorId: opts.actorId, input: opts.input });
    return { runId: "r", status: "SUCCEEDED", items: [], durationMs: 1, datasetId: null, statusMessage: null };
  }),
}));

import { ApifyProvider } from "@/lib/providers/apify-provider";
import { makeProviderConfig, makeVideo } from "./helpers";
import type { PlatformProfile } from "@/lib/types";

const tiktokProfile: PlatformProfile = {
  id: "p1",
  campaignId: "c1",
  platform: "tiktok",
  profileUrl: "https://www.tiktok.com/@cybernick0x",
  handle: "cybernick0x",
  externalProfileId: null,
  lastDiscoveredAt: null,
  status: "live",
};
const igProfile: PlatformProfile = { ...tiktokProfile, platform: "instagram", profileUrl: "https://www.instagram.com/cybernick0x", id: "p2" };

const anyInputHas = (key: string) => captured.some((c) => key in c.input);

describe("TikTok comment add-on (commentsPerPost) cost gate", () => {
  beforeEach(() => {
    captured.length = 0;
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    delete process.env.APIFY_TOKEN;
    vi.clearAllMocks();
  });

  const tiktok = () =>
    new ApifyProvider("tiktok", makeProviderConfig({ platform: "tiktok", actorId: "GdWCkxBtKWOsKjdch", supportsComments: true }));
  const video = makeVideo({ platform: "tiktok", originalUrl: "https://www.tiktok.com/@cybernick0x/video/123", externalVideoId: "123" });

  it("does NOT request commentsPerPost on a metrics-only refresh", async () => {
    await tiktok().fetchPlatform(tiktokProfile, [video], new Date("2026-06-01"), { wantComments: false });
    expect(captured.length).toBeGreaterThan(0);
    expect(anyInputHas("commentsPerPost")).toBe(false);
  });

  it("DOES request commentsPerPost on a comment-detail refresh", async () => {
    await tiktok().fetchPlatform(tiktokProfile, [video], new Date("2026-06-01"), { wantComments: true });
    expect(anyInputHas("commentsPerPost")).toBe(true);
  });
});

describe("Instagram share-count add-on cost gate", () => {
  beforeEach(() => {
    captured.length = 0;
    process.env.APIFY_TOKEN = "test-token";
  });
  afterEach(() => {
    delete process.env.APIFY_TOKEN;
    delete process.env.ENABLE_INSTAGRAM_SHARES;
    vi.clearAllMocks();
  });

  const ig = () =>
    new ApifyProvider("instagram", makeProviderConfig({ platform: "instagram", actorId: "xMc5Ga1oCONPmWJIa", supportsComments: false }));
  const video = makeVideo({ platform: "instagram", originalUrl: "https://www.instagram.com/cybernick0x/reel/DZWaZjlggrV/", externalVideoId: "DZWaZjlggrV" });

  it("is OFF by default (no includeSharesCount in the input)", async () => {
    await ig().fetchPlatform(igProfile, [video], new Date("2026-06-01"), { wantComments: false });
    expect(captured.length).toBeGreaterThan(0);
    expect(anyInputHas("includeSharesCount")).toBe(false);
  });

  it("is ON only when ENABLE_INSTAGRAM_SHARES=1", async () => {
    process.env.ENABLE_INSTAGRAM_SHARES = "1";
    await ig().fetchPlatform(igProfile, [video], new Date("2026-06-01"), { wantComments: false });
    expect(anyInputHas("includeSharesCount")).toBe(true);
  });
});
