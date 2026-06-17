// Visibility heal (a valid campaign video that was "already tracked" but excluded
// by a corrupt date / hidden flag), manual-add restore path, and the thumbnail
// retry state machine.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextThumbnailState, readThumbState, MAX_THUMBNAIL_RETRIES, type ThumbnailState } from "@/lib/thumbnail-state";
import type { NormalizedVideo } from "@/lib/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const VALID = (over: Partial<ThumbnailState> = {}): ThumbnailState => ({ status: "valid", attempts: 0, lastAttemptAt: "2026-06-16T00:00:00Z", nextRetryAt: null, failureReason: null, resolvedFrom: "provider", ...over });
const MISSING: ThumbnailState = { status: "missing", attempts: 0, lastAttemptAt: null, nextRetryAt: null, failureReason: null, resolvedFrom: null };

// ── 1) Thumbnail retry state machine ──────────────────────────────────────────
describe("nextThumbnailState", () => {
  const now = "2026-06-16T12:00:00Z";
  it("provider thumbnail → valid, resets attempts", () => {
    const r = nextThumbnailState({ resolvedUrl: "https://cdn/x.jpg", existingUrl: null, prev: MISSING, isDiscovery: true, now });
    expect(r.thumbnailUrl).toBe("https://cdn/x.jpg");
    expect(r.thumb.status).toBe("valid");
  });
  it("missing on a discovery pull → retry_pending and counts an attempt", () => {
    const r = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev: MISSING, isDiscovery: true, now });
    expect(r.thumb.status).toBe("retry_pending");
    expect(r.thumb.attempts).toBe(1);
  });
  it("missing on a METRICS pull does NOT count an attempt", () => {
    const r = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev: { ...MISSING, status: "retry_pending", attempts: 1 }, isDiscovery: false, now });
    expect(r.thumb.attempts).toBe(1); // unchanged
  });
  it("caps at MAX retries then → failed (no infinite retry)", () => {
    const prev = { ...MISSING, status: "retry_pending" as const, attempts: MAX_THUMBNAIL_RETRIES - 1 };
    const r = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev, isDiscovery: true, now });
    expect(r.thumb.status).toBe("failed");
    const again = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev: r.thumb, isDiscovery: true, now });
    expect(again.thumb.attempts).toBe(r.thumb.attempts); // no more counting
  });
  it("never overwrites a last-known-good thumbnail when the provider returns none", () => {
    const r = nextThumbnailState({ resolvedUrl: null, existingUrl: "https://cdn/good.jpg", prev: VALID(), isDiscovery: true, now });
    expect(r.thumbnailUrl).toBe("https://cdn/good.jpg");
    expect(r.thumb.status).toBe("valid");
  });
  it("never overwrites a MANUAL thumbnail with a provider one", () => {
    const r = nextThumbnailState({ resolvedUrl: "https://cdn/provider.jpg", existingUrl: "https://cdn/manual.jpg", prev: VALID({ resolvedFrom: "manual" }), isDiscovery: true, now });
    expect(r.thumbnailUrl).toBe("https://cdn/manual.jpg");
    expect(r.thumb.resolvedFrom).toBe("manual");
  });
  it("readThumbState defaults cleanly for a record with no thumb state", () => {
    expect(readThumbState({ source: "socialcrawl" }).status).toBe("missing");
  });
});

// ── 2) Integration: heal + manual-add restore (real pipeline / route) ─────────
const ctrl = vi.hoisted(() => ({ tiktok: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/providers/registry", () => {
  const ready = (platform: string) => ({
    provider: {
      providerType: "socialcrawl" as const, supportsComments: false, supportsDiscovery: true,
      fetchPlatform: async () => (platform === "tiktok" && ctrl.tiktok ? ctrl.tiktok() : { videos: [], commentsByVideo: {}, attempts: [] }),
    },
    readiness: { ready: true, status: "live" as const, sourceStatus: "live" as const, detail: null },
    config: null,
  });
  const resolveProvider = async (p: string) => ready(p);
  const resolveAllProviders = async () => ({ tiktok: await ready("tiktok"), youtube: await ready("youtube"), instagram: await ready("instagram"), facebook: await ready("facebook") });
  return { resolveProvider, resolveAllProviders };
});

import { runRefresh } from "@/lib/refresh";
import { ensureSeedData } from "@/lib/seed";
import { getDashboardData } from "@/lib/queries";
import { getStore } from "@/lib/store";
import { POST as addVideo } from "@/app/api/admin/videos/route";
import { NextRequest } from "next/server";
import { useTmpCwd, type TmpCwd } from "./helpers";

const TT = (id: string) => `https://www.tiktok.com/@cybernick0x/video/${id}`;
const nv = (id: string, over: Partial<NormalizedVideo> = {}): NormalizedVideo => ({
  platform: "tiktok", originalUrl: TT(id), externalVideoId: id, title: `v${id}`, caption: null, thumbnailUrl: "https://cdn/x.jpg",
  publishedAt: "2020-06-01T00:00:00.000Z", authorName: null, authorHandle: null, views: 1000, likes: null, comments: null,
  shares: null, saves: null, bookmarks: null, rawJson: { source: "socialcrawl" }, ...over,
});
const insert = (store: ReturnType<typeof getStore>, campaignId: string, over: Record<string, unknown>) =>
  store.insertVideo({
    campaignId, platform: "tiktok", profileId: null, originalUrl: TT("X"), externalVideoId: "X", title: "t", caption: null,
    thumbnailUrl: null, publishedAt: "2026-06-15T00:00:00.000Z", firstTrackedAt: "2026-06-15T00:00:00.000Z", lastRefreshedAt: null,
    status: "active", episodeGroupId: null, sourceStatus: "live", errorMessage: null, hidden: false, isSeed: false, rawJson: null,
    ...over,
  } as Parameters<typeof store.insertVideo>[0]);

describe("heal + manual-add restore (integration)", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd(); reset(); ctrl.tiktok = null;
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01";
    delete process.env.ADMIN_PASSWORD; // guardAdmin is open when no password is set
  });
  afterEach(async () => {
    reset(); ctrl.tiktok = null; delete process.env.CAMPAIGN_START_DATE_ET;
    (globalThis as unknown as { __wachterRefreshing?: unknown }).__wachterRefreshing = undefined;
    await tmp.cleanup();
  });

  it("heals an excluded (Jan-1970-date) record when the provider supplies a valid date; keeps pre-campaign excluded", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const heal = await insert(store, campaign.id, { originalUrl: TT("HEAL1"), externalVideoId: "HEAL1", publishedAt: "1970-01-21T00:00:00.000Z" });
    const old = await insert(store, campaign.id, { originalUrl: TT("OLD1"), externalVideoId: "OLD1", publishedAt: "2019-01-01T00:00:00.000Z" });
    ctrl.tiktok = async () => ({
      videos: [
        nv("HEAL1", { publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), views: 4242 }), // real recent date → heal
        nv("OLD1", { publishedAt: "2019-01-01T00:00:00.000Z", views: 9999 }), // genuinely pre-campaign → stays excluded
      ],
      commentsByVideo: {}, attempts: [],
    });
    await runRefresh("script");
    const healed = await store.getVideo(heal.id);
    expect(new Date(healed!.publishedAt!).getUTCFullYear()).toBe(new Date().getUTCFullYear());
    expect(healed!.hidden).toBe(false);
    const oldAfter = await store.getVideo(old.id);
    expect(oldAfter!.publishedAt).toBe("2019-01-01T00:00:00.000Z"); // untouched
    const dash = await getDashboardData("all");
    expect(dash.kpis.totalViews).toBe(4242); // healed counts; pre-campaign excluded
  });

  it("manual add of a hidden record restores it instead of dead-ending", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insert(store, campaign.id, { originalUrl: TT("HID1"), externalVideoId: "HID1", hidden: true, publishedAt: "2026-06-15T00:00:00.000Z" });
    const req = new NextRequest("http://localhost/api/admin/videos", { method: "POST", body: JSON.stringify({ url: TT("HID1") }) });
    const res = await addVideo(req);
    const body = (await res.json()) as { ok: boolean; restored?: boolean };
    expect(body.ok).toBe(true);
    expect(body.restored).toBe(true);
    expect((await store.getVideo(v.id))!.hidden).toBe(false);
  });

  it("manual add of a visible record reports it (not a dead-end), out-of-campaign explains", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    await insert(store, campaign.id, { originalUrl: TT("VIS1"), externalVideoId: "VIS1", publishedAt: "2026-06-15T00:00:00.000Z" });
    await insert(store, campaign.id, { originalUrl: TT("PRE1"), externalVideoId: "PRE1", publishedAt: "2019-01-01T00:00:00.000Z", hidden: true });
    const visRes = await addVideo(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ url: TT("VIS1") }) }));
    expect((await visRes.json()) as { ok: boolean; state?: string }).toMatchObject({ ok: false, state: "visible" });
    const preRes = await addVideo(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ url: TT("PRE1") }) }));
    expect((await preRes.json()) as { ok: boolean; state?: string }).toMatchObject({ ok: false, state: "excluded" });
  });

  it("a valid video with NO thumbnail is still tracked (not blocked) and marked retry_pending", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insert(store, campaign.id, { originalUrl: TT("NOTH"), externalVideoId: "NOTH", publishedAt: "2026-06-15T00:00:00.000Z", thumbnailUrl: null });
    ctrl.tiktok = async () => ({ videos: [nv("NOTH", { thumbnailUrl: null, publishedAt: "2026-06-15T00:00:00.000Z" })], commentsByVideo: {}, attempts: [] });
    await runRefresh("script");
    const after = await store.getVideo(v.id);
    expect(after).toBeDefined(); // still tracked
    expect(after!.hidden).toBe(false);
    expect(readThumbState(after!.rawJson).status).toBe("retry_pending");
  });
});

// ── 3) Safety ─────────────────────────────────────────────────────────────────
describe("safety — no secrets / internals / actor IDs", () => {
  it("manual-add route stays admin-gated", () => {
    expect(read("src/app/api/admin/videos/route.ts")).toContain("guardAdmin");
  });
  it("thumbnail-state module exposes no secrets / provider internals", () => {
    const src = read("src/lib/thumbnail-state.ts");
    expect(src).not.toMatch(/sc_[A-Za-z0-9]{20,}/);
    expect(src).not.toMatch(/actorId|x-api-key/);
  });
});
