import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as addVideo } from "@/app/api/admin/videos/route";
import { POST as backfill } from "@/app/api/admin/backfill-published-at/route";
import { ADMIN_COOKIE, mintSessionCookie } from "@/lib/auth";
import { isCampaignEligible } from "@/lib/eligibility";
import { getDashboardData } from "@/lib/queries";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import type { Video } from "@/lib/types";
import { makeSnapshot, makeVideo, stashEnv, useTmpCwd, type TmpCwd } from "./helpers";

const publishedAt = "2026-07-10T12:00:00.000Z";
const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
const request = (body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/admin/videos", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const cronRequest = (body?: unknown) => request(body, { authorization: "Bearer test-cron" });

function mockYouTube(date: string | null = publishedAt) {
  const mock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    // Any paid-provider call fails this test; only videos.list is permitted.
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
    const ids = url.searchParams.get("id")!.split(",");
    expect(ids.length).toBeLessThanOrEqual(50);
    return Response.json({ items: ids.map((id) => ({
      id,
      snippet: { title: "YouTube title", description: "YouTube caption", publishedAt: date,
        thumbnails: { high: { url: "https://i.ytimg.com/thumbnail.jpg" } } },
    })) });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function insertVideo(id: string, patch: Partial<Video> = {}) {
  const store = getStore();
  const campaign = await ensureSeedData(store);
  return store.insertVideo(makeVideo({
    id, campaignId: campaign.id, platform: "youtube", externalVideoId: id,
    originalUrl: `https://www.youtube.com/shorts/${id}`, ...patch,
  }));
}

let tmp: TmpCwd;
let restore: () => void;
beforeEach(async () => {
  tmp = await useTmpCwd();
  reset();
  restore = stashEnv(["DATABASE_URL", "MOCK_DATA", "ADMIN_PASSWORD", "CRON_SECRET", "YOUTUBE_API_KEY", "CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE"]);
  process.env.YOUTUBE_API_KEY = "test-youtube-key";
  process.env.CRON_SECRET = "test-cron";
  process.env.CAMPAIGN_START_DATE_ET = "2020-01-01";
  process.env.BOOTCAMP_START_DATE = "2020-01-01";
  const store = getStore();
  await ensureSeedData(store);
  // Keep the baseline seed out of the missing-date fixture counts.
  for (const video of await store.listVideos({ platform: "youtube", includeHidden: true })) {
    await store.updateVideo(video.id, { publishedAt });
  }
});
afterEach(async () => {
  vi.unstubAllGlobals();
  reset();
  restore();
  await tmp.cleanup();
});

describe("admin add — YouTube publish date", () => {
  it("inserts API metadata on add so the video is immediately eligible", async () => {
    const fetchMock = mockYouTube();
    const res = await addVideo(request({ url: "https://youtu.be/NEWSHORT123" }));
    expect(res.status).toBe(200);
    const { video } = await res.json();
    expect(video).toMatchObject({ publishedAt, title: "YouTube title", caption: "YouTube caption",
      thumbnailUrl: "https://i.ytimg.com/thumbnail.jpg", originalUrl: "https://www.youtube.com/shorts/NEWSHORT123" });
    expect(isCampaignEligible(video)).toBe(true);
    expect((await getStore().getVideo(video.id))!.publishedAt).toBe(publishedAt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(video)).not.toContain(process.env.YOUTUBE_API_KEY);
  });

  it("does not insert a permanently date-missing video when the API key is absent", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const fetchMock = mockYouTube();
    const res = await addVideo(request({ url: "https://youtu.be/NEWSHORT123" }));
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getStore().findVideoByUrlOrExternalId("youtube", null, "NEWSHORT123")).toBeNull();
  });

  it.each([null, "invalid"])("rejects missing/invalid API dates (%s) without inserting", async (date) => {
    mockYouTube(date);
    const res = await addVideo(request({ url: "https://youtu.be/NEWSHORT123" }));
    expect(res.status).toBe(502);
    expect(await getStore().findVideoByUrlOrExternalId("youtube", null, "NEWSHORT123")).toBeNull();
  });

  it("returns a safe error on API failure, with no paid fallback or insertion", async () => {
    const fetchMock = vi.fn(async () => { throw new Error(`network failure ${process.env.YOUTUBE_API_KEY}`); });
    vi.stubGlobal("fetch", fetchMock);
    const res = await addVideo(request({ url: "https://youtu.be/NEWSHORT123" }));
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(process.env.YOUTUBE_API_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await getStore().findVideoByUrlOrExternalId("youtube", null, "NEWSHORT123")).toBeNull();
  });

  it("preserves TikTok date derivation without calling YouTube", async () => {
    const fetchMock = mockYouTube();
    const res = await addVideo(request({ url: "https://www.tiktok.com/@creator/video/7511234567890123456" }));
    expect(res.status).toBe(200);
    expect((await res.json()).video.publishedAt).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("publishedAt backfill", () => {
  it("defaults to dry run even with no body; excluded rows never reach the API", async () => {
    const video = await insertVideo("MISSING01", { rawJson: { campaign: "bootcamp", tracking: { status: "active" } } });
    const excluded = await insertVideo("EXCLUDED1", { rawJson: { campaign: "mtl", tracking: { status: "excluded" } } });
    const fetchMock = mockYouTube();
    const res = await backfill(cronRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, candidates: 1, excludedSkipped: 1, found: 1, updated: 0 });
    expect(await getStore().getVideo(video.id)).toEqual(video);
    expect(await getStore().getVideo(excluded.id)).toEqual(excluded);
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("id")).toBe("MISSING01");
  });

  it("confirm writes only dates, preserves tags, and keeps lifetime All = MTL + Bootcamp", async () => {
    const store = getStore();
    const missing = await insertVideo("MISSING01", { title: "Keep title", rawJson: { campaign: "bootcamp", tracking: { status: "active", reason: "curated" }, custom: "keep" } });
    const excluded = await insertVideo("EXCLUDED1", { hidden: true, rawJson: { campaign: "mtl", tracking: { status: "excluded" } } });
    const dated = await insertVideo("DATED0001", { publishedAt });
    const videos = [missing, dated];
    for (const platform of ["tiktok", "instagram", "facebook"] as const) {
      videos.push(await insertVideo(`${platform}-mtl`, { platform, publishedAt, rawJson: { campaign: "mtl" } }));
      videos.push(await insertVideo(`${platform}-boot`, { platform, publishedAt, rawJson: { campaign: "bootcamp" } }));
    }
    for (const video of videos) {
      await store.addSnapshot(makeSnapshot({ videoId: video.id, capturedAt: "2026-07-10T00:00:00.000Z", views: 10 }));
      await store.addSnapshot(makeSnapshot({ videoId: video.id, capturedAt: "2026-07-11T00:00:00.000Z", views: 100 }));
    }
    mockYouTube();
    const res = await backfill(cronRequest({ confirm: true }));
    expect(await res.json()).toMatchObject({ dryRun: false, found: 1, updated: 1, excludedSkipped: 1 });
    expect(await store.getVideo(missing.id)).toEqual({ ...missing, publishedAt });
    expect(await store.getVideo(excluded.id)).toEqual(excluded);
    expect(await store.getVideo(dated.id)).toEqual(dated);
    for (const range of ["24h", "7d", "30d", "all"] as const) {
      const all = await getDashboardData(range, "all");
      const mtl = await getDashboardData(range, "mtl");
      const boot = await getDashboardData(range, "bootcamp");
      expect(all.kpis.totalViews).toBe(800); // latest snapshots, across all platforms
      expect(all.kpis.totalViews).toBe(mtl.kpis.totalViews! + boot.kpis.totalViews!);
    }
    expect((await (await backfill(cronRequest({ confirm: true }))).json()).updated).toBe(0);
  });

  it("batches more than 50 IDs and only literal confirm:true writes", async () => {
    for (let i = 0; i < 51; i++) await insertVideo(`SHORT${i}`);
    const fetchMock = mockYouTube();
    const res = await backfill(cronRequest({ confirm: "true" }));
    expect(await res.json()).toMatchObject({ dryRun: true, candidates: 51, found: 51, updated: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("counts unavailable metadata and missing IDs without inventing dates", async () => {
    await insertVideo("MISSING01");
    await insertVideo("NOID00001", { externalVideoId: null, originalUrl: "https://www.youtube.com/" });
    mockYouTube(null);
    expect(await (await backfill(cronRequest({ confirm: true }))).json()).toMatchObject({ missingId: 1, unavailable: 1, updated: 0 });
  });

  it("rechecks exclusion after the API lookup before writing", async () => {
    const video = await insertVideo("MISSING01");
    vi.stubGlobal("fetch", vi.fn(async () => {
      await getStore().updateVideo(video.id, { rawJson: { tracking: { status: "excluded" } } });
      return Response.json({ items: [{ id: "MISSING01", snippet: { publishedAt } }] });
    }));
    expect(await (await backfill(cronRequest({ confirm: true }))).json()).toMatchObject({ updated: 0, skippedChanged: 1 });
    expect((await getStore().getVideo(video.id))!.publishedAt).toBeNull();
  });

  it("reports a failed batch safely without writing or falling back to paid providers", async () => {
    const video = await insertVideo("MISSING01");
    const fetchMock = vi.fn(async () => { throw new Error(`request failed ${process.env.YOUTUBE_API_KEY}`); });
    vi.stubGlobal("fetch", fetchMock);
    const res = await backfill(cronRequest({ confirm: true }));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, failed: 1, updated: 0 });
    expect(JSON.stringify(body)).not.toContain(process.env.YOUTUBE_API_KEY);
    expect(await getStore().getVideo(video.id)).toEqual(video);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed without credentials or with a wrong bearer; accepts an admin session", async () => {
    const fetchMock = mockYouTube();
    expect((await backfill(request({ confirm: true }))).status).toBe(401);
    expect((await backfill(request({}, { authorization: "Bearer wrong" }))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await backfill(request({}))).status).toBe(401);
    process.env.ADMIN_PASSWORD = "test-admin";
    const cookie = `${ADMIN_COOKIE}=${mintSessionCookie()}`;
    expect((await backfill(request({}, { cookie }))).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
