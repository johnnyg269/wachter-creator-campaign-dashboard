// Admin campaign reassignment from the video detail drawer. The write goes
// through the SAME guardAdmin PATCH /api/admin/videos/[id] route (rawJson.campaign
// only) — so this verifies the campaign math (views move between campaign totals,
// All = Bootcamp + MTL always), that nothing else is touched (metrics/snapshots/
// comments/thumbnail/tracking/other rawJson keys), that the refresh tier follows
// the new campaign, that excluded records are never reactivated, and that the
// selector is admin-gated (401 without a session, hidden from the public view).

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/admin/videos/[id]/route";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { getDashboardData } from "@/lib/queries";
import { videoCampaign, videoTrackingStatus, isAdminExcluded } from "@/lib/campaigns";
import { videoRefreshTier } from "@/lib/refresh-tiers";
import type { Video } from "@/lib/types";
import { useTmpCwd, stashEnv, makeSnapshot, makeComment, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);

let n = 0;
async function insertVid(
  campaignId: string,
  campaign: "bootcamp" | "mtl",
  views: number,
  extraRaw: Record<string, unknown> = {},
): Promise<Video> {
  const store = getStore();
  n += 1;
  const v = await store.insertVideo({
    campaignId,
    platform: "facebook",
    profileId: null,
    originalUrl: `https://www.facebook.com/reel/${campaign}-${n}`,
    externalVideoId: `e${n}`,
    title: `video ${n}`,
    caption: null,
    thumbnailUrl: `https://scontent.xx.fbcdn.net/v/c${n}.jpg`,
    publishedAt: "2026-07-10T00:00:00.000Z",
    firstTrackedAt: "2026-07-10T00:00:00.000Z",
    lastRefreshedAt: "2026-07-12T00:00:00.000Z",
    status: "active",
    episodeGroupId: null,
    sourceStatus: "live",
    errorMessage: null,
    hidden: false,
    isSeed: false,
    rawJson: { source: "socialcrawl", campaign, ...extraRaw } as Video["rawJson"],
  } as Parameters<typeof store.insertVideo>[0]);
  await store.addSnapshot(makeSnapshot({ videoId: v.id, capturedAt: "2026-07-12T00:00:00.000Z", views }));
  return v;
}

const callPatch = (id: string, body: Record<string, unknown>, cookie?: string) =>
  PATCH(
    new NextRequest("http://localhost/api/admin/videos/x", {
      method: "PATCH",
      headers: cookie ? { "Content-Type": "application/json", cookie } : { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

// An empty campaign reports totalViews=null ("no data"); for move-math an empty
// campaign contributes 0, so coerce null→0 to keep the All = B + M invariant clean.
const totals = async () => ({
  all: (await getDashboardData("all", "all")).kpis.totalViews ?? 0,
  boot: (await getDashboardData("all", "bootcamp")).kpis.totalViews ?? 0,
  mtl: (await getDashboardData("all", "mtl")).kpis.totalViews ?? 0,
});

describe("campaign edit — server gate", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE", "ADMIN_PASSWORD"]);
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01";
    process.env.BOOTCAMP_START_DATE = "2020-01-01";
  });
  afterEach(async () => {
    reset();
    restore();
    await tmp.cleanup();
  });

  it("rejects an unauthenticated campaign update with 401 when a password is configured", async () => {
    process.env.ADMIN_PASSWORD = "s3cret";
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "mtl", 1000);
    const res = await callPatch(v.id, { campaign: "bootcamp" }); // no cookie
    expect(res.status).toBe(401);
    expect(videoCampaign((await store.getVideo(v.id))!)).toBe("mtl"); // unchanged
  });

  it("rejects an invalid campaign value with 400", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "mtl", 1000);
    const res = await callPatch(v.id, { campaign: "nonsense" });
    expect(res.status).toBe(400);
  });
});

describe("campaign edit — behavior + math", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE", "ADMIN_PASSWORD"]);
    process.env.CAMPAIGN_START_DATE_ET = "2020-01-01";
    process.env.BOOTCAMP_START_DATE = "2020-01-01";
    delete process.env.ADMIN_PASSWORD; // guardAdmin open in this suite
  });
  afterEach(async () => {
    reset();
    restore();
    await tmp.cleanup();
  });

  it("MTL → Bootcamp moves views to Bootcamp; All unchanged; other video untouched; tier → bootcamp_daily", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const mover = await insertVid(campaign.id, "mtl", 1000);
    const other = await insertVid(campaign.id, "mtl", 500);

    const base = await totals();
    expect(base).toEqual({ all: 1500, boot: 0, mtl: 1500 });

    const res = await callPatch(mover.id, { campaign: "bootcamp" });
    expect(res.status).toBe(200);

    const after = await totals();
    expect(after.boot).toBe(1000); // gained exactly the mover's views
    expect(after.mtl).toBe(500); // lost exactly the mover's views
    expect(after.all).toBe(1500); // All unchanged
    expect(after.all).toBe((after.boot ?? 0) + (after.mtl ?? 0)); // All = B + M

    const moved = await store.getVideo(mover.id);
    expect(videoCampaign(moved!)).toBe("bootcamp");
    expect(videoRefreshTier(moved!)).toBe("bootcamp_daily");
    expect(videoCampaign((await store.getVideo(other.id))!)).toBe("mtl"); // untouched
  });

  it("Bootcamp → MTL moves views to MTL; All unchanged; tier → mtl_hot/warm (not bootcamp)", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const mover = await insertVid(campaign.id, "bootcamp", 2000);
    await insertVid(campaign.id, "mtl", 300);

    expect(await totals()).toEqual({ all: 2300, boot: 2000, mtl: 300 });
    const res = await callPatch(mover.id, { campaign: "mtl" });
    expect(res.status).toBe(200);

    const after = await totals();
    expect(after).toEqual({ all: 2300, boot: 0, mtl: 2300 });
    const moved = await store.getVideo(mover.id);
    expect(videoCampaign(moved!)).toBe("mtl");
    expect(["mtl_hot", "mtl_warm"]).toContain(videoRefreshTier(moved!));
    expect(videoRefreshTier(moved!)).not.toBe("bootcamp_daily");
  });

  it("→ Unassigned removes it from Bootcamp/MTL/All public totals but keeps it admin-visible (not hidden, not excluded)", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const mover = await insertVid(campaign.id, "mtl", 900);
    await insertVid(campaign.id, "bootcamp", 100);

    expect(await totals()).toEqual({ all: 1000, boot: 100, mtl: 900 });
    const res = await callPatch(mover.id, { campaign: "unassigned" });
    expect(res.status).toBe(200);

    const after = await totals();
    expect(after.mtl).toBe(0);
    expect(after.boot).toBe(100);
    expect(after.all).toBe(100); // dropped from All too
    // Still present, still active, just unassigned → admin-visible, not deleted/hidden.
    const rec = await store.getVideo(mover.id);
    expect(rec).toBeTruthy();
    expect(rec!.hidden).toBe(false);
    expect(videoTrackingStatus(rec!)).toBe("active");
    expect(videoCampaign(rec!)).toBeNull();
  });

  it("changes ONLY rawJson.campaign — preserves snapshots, comments, thumbnail, tracking, other rawJson keys; no provider calls", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "mtl", 1234, { discoveryReview: false, customFlag: "keep-me" });
    await store.addSnapshot(makeSnapshot({ videoId: v.id, capturedAt: "2026-07-13T00:00:00.000Z", views: 1300 }));
    await store.upsertComment(makeComment({ videoId: v.id, platform: "facebook", text: "nice" }));
    const snapsBefore = (await store.listSnapshots(v.id)).length;
    const commentsBefore = (await store.listComments()).length;
    const attemptsBefore = (await store.listCollectionAttempts()).length;
    const thumbBefore = v.thumbnailUrl;

    const res = await callPatch(v.id, { campaign: "bootcamp" });
    expect(res.status).toBe(200);

    const after = await store.getVideo(v.id);
    expect(videoCampaign(after!)).toBe("bootcamp"); // only this changed
    expect(after!.thumbnailUrl).toBe(thumbBefore); // thumbnail untouched
    expect((await store.listSnapshots(v.id)).length).toBe(snapsBefore); // snapshots untouched
    expect((await store.listComments()).length).toBe(commentsBefore); // comments untouched
    // No SocialCrawl / Apify / provider call happened (no new collection attempts).
    expect((await store.listCollectionAttempts()).length).toBe(attemptsBefore);
    // Other rawJson keys preserved (carryOverAdminTags-style safe merge).
    const raw = after!.rawJson as Record<string, unknown>;
    expect(raw.source).toBe("socialcrawl");
    expect(raw.customFlag).toBe("keep-me");
  });

  it("does NOT reactivate an excluded/removed record when its campaign is set", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "mtl", 500, {
      tracking: { status: "excluded", excludedAt: "2026-07-11T00:00:00.000Z", reason: "spam" },
    });
    await store.updateVideo(v.id, { hidden: true });

    const res = await callPatch(v.id, { campaign: "bootcamp" });
    expect(res.status).toBe(200); // the tag write itself is allowed…
    const after = await store.getVideo(v.id);
    // …but the record stays excluded + hidden (exclusion dominates campaign).
    expect(isAdminExcluded(after!)).toBe(true);
    expect(after!.hidden).toBe(true);
    expect(videoTrackingStatus(after!)).toBe("excluded");
    expect(videoCampaign(after!)).toBeNull(); // excluded → campaign resolves null (stays out of totals)
    expect(videoRefreshTier(after!)).toBe("none"); // excluded → never refreshed
  });
});

describe("campaign selector — rendering gates (source-level)", () => {
  const explorer = read("src/app/videos/videos-explorer.tsx");

  it("the selector only renders for admin and only on non-excluded rows", () => {
    expect(explorer).toContain("{admin && r.trackingStatus !== \"excluded\" && (");
    expect(explorer).toContain("<CampaignEditor");
    // CampaignEditor is only reachable through the admin-gated block above.
    expect(explorer).toContain("onSetCampaign: (id: string, campaign:");
  });

  it("public view never sees the selector (Apply flows through the admin route only)", () => {
    // The only mutation endpoint remains the guardAdmin videos route…
    const targets = [...explorer.matchAll(/fetch\(`([^`]+)`/g)].map((m) => m[1]);
    expect(targets.every((t) => t.includes("/api/admin/videos/"))).toBe(true);
    // …and there is no Supabase browser client anywhere in the explorer.
    expect(explorer).not.toMatch(/@supabase|createClient|SUPABASE_ANON|NEXT_PUBLIC_SUPABASE/);
  });
});
