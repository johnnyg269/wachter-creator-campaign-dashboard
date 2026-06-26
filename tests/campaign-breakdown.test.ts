// Combined-total breakdown: All === Bootcamp + MTL (views + videos), pending
// counts videos with null confirmed views, and excluded/unassigned (campaign
// null) never count. Display-only — built from real confirmed metrics.

import { describe, expect, it } from "vitest";
import { buildCampaignBreakdown, type CampaignData } from "@/lib/queries";
import type { MetricSnapshot, Video } from "@/lib/types";
import type { VideoMetrics } from "@/lib/metrics";

type Resolved = Video & { campaign: "mtl" | "bootcamp" | null };

const vid = (id: string, campaign: "mtl" | "bootcamp" | null): Resolved =>
  ({ id, campaign, platform: "tiktok", originalUrl: `u/${id}`, publishedAt: "2026-05-01T00:00:00.000Z", hidden: false } as unknown as Resolved);

const metrics = (views: number | null): VideoMetrics => ({ confirmed: { views: views === null ? null : { value: views, at: "", stale: false, manual: false } } } as unknown as VideoMetrics);

const snap = (videoId: string, at: string): MetricSnapshot =>
  ({ id: at, videoId, capturedAt: at, views: 1, likes: null, comments: null, shares: null, saves: null, bookmarks: null, engagementRate: null, rawJson: null });

describe("buildCampaignBreakdown", () => {
  it("All == Bootcamp + MTL (views + videos); pending counts null views; null campaign excluded", () => {
    const videos = [vid("b1", "bootcamp"), vid("b2", "bootcamp"), vid("m1", "mtl"), vid("x", null)];
    const metricsByVideo = new Map<string, VideoMetrics>([
      ["b1", metrics(1000)],
      ["b2", metrics(null)], // pending
      ["m1", metrics(500)],
      ["x", metrics(9999)], // campaign null → must NOT count anywhere
    ]);
    const snapshotsByVideo = new Map<string, MetricSnapshot[]>([
      ["b1", [snap("b1", "2026-06-20T00:00:00.000Z")]],
      ["m1", [snap("m1", "2026-06-25T12:00:00.000Z")]],
    ]);
    const data = { videos, metricsByVideo, snapshotsByVideo } as unknown as CampaignData;

    const b = buildCampaignBreakdown(data);
    expect(b.bootcamp.views).toBe(1000);
    expect(b.bootcamp.videos).toBe(2);
    expect(b.bootcamp.pendingMetrics).toBe(1);
    expect(b.mtl.views).toBe(500);
    expect(b.mtl.videos).toBe(1);
    // All === Bootcamp + MTL exactly; the null-campaign video (x, 9999 views) is
    // excluded from every slot.
    expect(b.all.videos).toBe(3);
    expect(b.all.views).toBe(1500);
    expect(b.all.views).toBe((b.bootcamp.views ?? 0) + (b.mtl.views ?? 0));
    expect(b.all.pendingMetrics).toBe(b.bootcamp.pendingMetrics + b.mtl.pendingMetrics);
    expect(b.lastUpdated).toBe("2026-06-25T12:00:00.000Z");
  });
});
