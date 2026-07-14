// Admin remove/restore from the Videos page: server-enforced gate (401 without a
// session when a password is configured), exact delete-math (removing one video
// drops the campaign + All totals by exactly its views, the other campaign is
// untouched, All still = Bootcamp + MTL), reversibility, tag preservation, and
// the source-level rendering gates that keep every control out of the public view.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { PATCH } from "@/app/api/admin/videos/[id]/route";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { getDashboardData, getRemovedVideosForAdmin, getVideosPageData } from "@/lib/queries";
import { videoCampaign, videoTrackingStatus } from "@/lib/campaigns";
import type { Video } from "@/lib/types";
import { useTmpCwd, stashEnv, makeSnapshot, type TmpCwd } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);

let n = 0;
async function insertVid(
  campaignId: string,
  campaign: "bootcamp" | "mtl",
  views: number,
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
    publishedAt: "2026-07-01T00:00:00.000Z",
    firstTrackedAt: "2026-07-01T00:00:00.000Z",
    lastRefreshedAt: "2026-07-10T00:00:00.000Z",
    status: "active",
    episodeGroupId: null,
    sourceStatus: "live",
    errorMessage: null,
    hidden: false,
    isSeed: false,
    rawJson: { source: "socialcrawl", campaign } as Video["rawJson"],
  } as Parameters<typeof store.insertVideo>[0]);
  await store.addSnapshot(makeSnapshot({ videoId: v.id, capturedAt: "2026-07-10T00:00:00.000Z", views }));
  return v;
}

const patchReq = (body: Record<string, unknown>, cookie?: string) =>
  new NextRequest("http://localhost/api/admin/videos/x", {
    method: "PATCH",
    headers: cookie ? { "Content-Type": "application/json", cookie } : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const callPatch = (id: string, body: Record<string, unknown>, cookie?: string) =>
  PATCH(patchReq(body, cookie), { params: Promise.resolve({ id }) });

describe("admin remove/restore — server gate", () => {
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

  it("rejects an unauthenticated remove with 401 when a password is configured", async () => {
    process.env.ADMIN_PASSWORD = "s3cret";
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "bootcamp", 1000);

    const res = await callPatch(v.id, { tracking: "exclude", reason: "spam" }); // no cookie
    expect(res.status).toBe(401);
    // Video untouched — still active, still public.
    expect((await store.getVideo(v.id))!.hidden).toBe(false);
    expect(videoTrackingStatus((await store.getVideo(v.id))!)).toBe("active");
  });

  it("rejects an unauthenticated restore with 401 too", async () => {
    process.env.ADMIN_PASSWORD = "s3cret";
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "bootcamp", 1000);
    const res = await callPatch(v.id, { tracking: "restore" });
    expect(res.status).toBe(401);
  });

  it("requires a reason to remove (guards accidental blanks)", async () => {
    // No ADMIN_PASSWORD → guardAdmin is open (dev), so we exercise the validation.
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "bootcamp", 1000);
    const res = await callPatch(v.id, { tracking: "exclude" });
    expect(res.status).toBe(400);
  });
});

describe("admin remove/restore — delete math + reversibility", () => {
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

  it("removing one video drops its campaign + All by exactly its views; other campaign untouched; restore returns", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const boot = await insertVid(campaign.id, "bootcamp", 1000);
    await insertVid(campaign.id, "mtl", 500);

    // Baseline
    const base = {
      all: (await getDashboardData("all", "all")).kpis.totalViews,
      boot: (await getDashboardData("all", "bootcamp")).kpis.totalViews,
      mtl: (await getDashboardData("all", "mtl")).kpis.totalViews,
    };
    expect(base.all).toBe(1500);
    expect(base.boot).toBe(1000);
    expect(base.mtl).toBe(500);
    expect(base.all).toBe((base.boot ?? 0) + (base.mtl ?? 0)); // All = B + M

    // Remove the Bootcamp video
    const res = await callPatch(boot.id, { tracking: "exclude", reason: "off-topic" });
    expect(res.status).toBe(200);

    const after = {
      all: (await getDashboardData("all", "all")).kpis.totalViews,
      boot: (await getDashboardData("all", "bootcamp")).kpis.totalViews,
      mtl: (await getDashboardData("all", "mtl")).kpis.totalViews,
    };
    expect(after.all).toBe(500); // dropped by exactly 1000
    expect(base.all! - after.all!).toBe(1000);
    expect(after.mtl).toBe(500); // MTL untouched
    expect(after.all).toBe((after.boot ?? 0) + (after.mtl ?? 0)); // All = B + M still holds

    // Not public: excluded from the Videos grid…
    const rows = (await getVideosPageData("all", "all")).rows;
    expect(rows.some((r) => r.video.id === boot.id)).toBe(false);
    // …hidden + excluded in the store…
    const removedRec = await store.getVideo(boot.id);
    expect(removedRec!.hidden).toBe(true);
    expect(videoTrackingStatus(removedRec!)).toBe("excluded");
    // …and present in the admin-only Removed view with its reason + views intact.
    const removed = await getRemovedVideosForAdmin();
    const entry = removed.find((r) => r.id === boot.id);
    expect(entry).toBeDefined();
    expect(entry!.views).toBe(1000);
    expect(entry!.removedReason).toBe("off-topic");

    // Restore returns it exactly.
    const restoreRes = await callPatch(boot.id, { tracking: "restore" });
    expect(restoreRes.status).toBe(200);
    const restored = await store.getVideo(boot.id);
    expect(restored!.hidden).toBe(false);
    expect(videoTrackingStatus(restored!)).toBe("active");
    expect(videoCampaign(restored!)).toBe("bootcamp"); // campaign tag preserved across remove+restore
    expect((await getDashboardData("all", "all")).kpis.totalViews).toBe(1500); // back to baseline
    expect((await getRemovedVideosForAdmin()).some((r) => r.id === boot.id)).toBe(false);
  });

  it("a removed video preserves its metrics/snapshots (soft delete only)", async () => {
    const store = getStore();
    const campaign = await ensureSeedData(store);
    const v = await insertVid(campaign.id, "bootcamp", 777);
    const before = (await store.listSnapshots(v.id)).length;
    await callPatch(v.id, { tracking: "exclude", reason: "dupe" });
    expect((await store.listSnapshots(v.id)).length).toBe(before); // snapshots untouched
  });
});

describe("rendering gates — controls never leak to the public view (source-level)", () => {
  const explorer = read("src/app/videos/videos-explorer.tsx");
  const page = read("src/app/videos/page.tsx");

  it("remove controls only construct when isAdmin", () => {
    expect(explorer).toContain("const admin: AdminControls | null = isAdmin ? { pendingId, onRemove: remove, onSetCampaign: setCampaign } : null;");
    // Cards receive `admin` (null when public) and only render RemoveButton under it.
    expect(explorer).toContain("{admin && <RemoveButton");
  });

  it("Removed view + error toast are gated on isAdmin", () => {
    expect(explorer).toContain("{isAdmin && removed.length > 0 && (");
    expect(explorer).toContain("{isAdmin && adminError && (");
  });

  it("the Open-video external link is safe (new tab, noopener) — allowed for everyone", () => {
    expect(explorer).toContain('target="_blank"');
    expect(explorer).toContain('rel="noopener noreferrer"');
  });

  it("page computes isAdmin server-side and only loads Removed data for an admin", () => {
    expect(page).toContain("const isAdmin = await isAdminAuthenticated();");
    expect(page).toContain("const removed = isAdmin ? await getRemovedVideosForAdmin() : [];");
    expect(page).toContain("isAdmin={isAdmin}");
  });

  it("the mutation route stays admin-gated (guardAdmin) — the flag never grants access", () => {
    expect(read("src/app/api/admin/videos/[id]/route.ts")).toContain("guardAdmin(req)");
  });
});
