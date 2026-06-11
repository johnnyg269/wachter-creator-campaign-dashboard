import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/store/json-store";
import { generateAlerts } from "@/lib/alerts";
import { makeVideo, useTmpCwd, type TmpCwd } from "./helpers";
import type { Campaign, MetricSnapshot } from "@/lib/types";

let tmp: TmpCwd;
let store: JsonStore;
let campaign: Campaign;

beforeEach(async () => {
  tmp = await useTmpCwd();
  store = new JsonStore();
  campaign = await store.upsertCampaign({
    name: "Test Campaign",
    creatorName: "Cybernick0x",
    company: "Wachter",
    startDate: "2026-06-01T00:00:00.000Z",
  });
});

afterEach(async () => {
  await tmp.cleanup();
});

function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

async function addSnap(videoId: string, capturedAt: string, partial: Partial<MetricSnapshot>) {
  await store.addSnapshot({
    videoId,
    capturedAt,
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    bookmarks: null,
    engagementRate: null,
    rawJson: null,
    ...partial,
  });
}

describe("generateAlerts", () => {
  it("emits a video_spike for fast hourly growth and dedupes on re-run", async () => {
    const v = await store.insertVideo(
      makeVideo({
        campaignId: campaign.id,
        title: "Spiking video",
        publishedAt: iso(60 * 24),
        lastRefreshedAt: iso(1),
        thumbnailUrl: "https://cdn.example/t.jpg",
      }),
    );
    // baseline >24h ago so the 24h average exists; +5000 views in the last hour
    await addSnap(v.id, iso(60 * 25), { views: 10_000 });
    await addSnap(v.id, iso(70), { views: 14_000 });
    await addSnap(v.id, iso(2), { views: 19_000 });

    await generateAlerts(store, campaign);
    const open = await store.listAlerts("open");
    const spikes = open.filter((a) => a.type === "video_spike");
    expect(spikes).toHaveLength(1);
    expect(spikes[0].message).toMatch(/\+5K|\+5,000|5000/i);

    // Re-running within the dedupe window must not duplicate the alert.
    await generateAlerts(store, campaign);
    expect((await store.listAlerts("open")).filter((a) => a.type === "video_spike")).toHaveLength(1);
  });

  it("emits high_engagement for ER >= 8% with enough views", async () => {
    const v = await store.insertVideo(
      makeVideo({
        campaignId: campaign.id,
        title: "Engaging video",
        publishedAt: iso(60),
        lastRefreshedAt: iso(1),
        thumbnailUrl: "https://cdn.example/t.jpg",
      }),
    );
    await addSnap(v.id, iso(2), { views: 5000, likes: 400, comments: 50, shares: 30 });
    await generateAlerts(store, campaign);
    const open = await store.listAlerts("open");
    expect(open.some((a) => a.type === "high_engagement" && a.videoId === v.id)).toBe(true);
  });

  it("emits missing_thumbnail and missing_metrics data-quality alerts", async () => {
    const v = await store.insertVideo(
      makeVideo({
        campaignId: campaign.id,
        title: "No data video",
        publishedAt: iso(30),
        lastRefreshedAt: iso(1),
        thumbnailUrl: null,
      }),
    );
    await addSnap(v.id, iso(2), { views: null, likes: 5 });
    await generateAlerts(store, campaign);
    const types = (await store.listAlerts("open")).map((a) => a.type);
    expect(types).toContain("missing_thumbnail");
    expect(types).toContain("missing_metrics");
  });

  it("emits no_new_posts when a platform has gone quiet", async () => {
    const v = await store.insertVideo(
      makeVideo({
        campaignId: campaign.id,
        platform: "facebook",
        title: "Old post",
        publishedAt: iso(60 * 24 * 10), // 10 days ago
        lastRefreshedAt: iso(1),
        thumbnailUrl: "https://cdn.example/t.jpg",
      }),
    );
    await addSnap(v.id, iso(2), { views: 100 });
    await generateAlerts(store, campaign);
    const open = await store.listAlerts("open");
    expect(open.some((a) => a.type === "no_new_posts" && a.platform === "facebook")).toBe(true);
  });

  it("does not emit metric alerts for videos with no snapshots", async () => {
    // recent firstTrackedAt so the (correct) no_new_posts rule stays quiet too
    await store.insertVideo(makeVideo({ campaignId: campaign.id, firstTrackedAt: iso(5) }));
    const created = await generateAlerts(store, campaign);
    expect(created).toBe(0);
  });
});
