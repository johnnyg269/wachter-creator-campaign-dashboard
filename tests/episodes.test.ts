// Admin episode management: store CRUD semantics (rename keeps assignments,
// delete reassigns but never deletes videos), route authentication, and the
// public Episodes page staying read-only and database-backed.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/store/json-store";
import { makeVideo, useTmpCwd, type TmpCwd } from "./helpers";

// Captured before useTmpCwd() swaps the working directory per test.
const REPO_ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), "utf-8");

let tmp: TmpCwd;
let store: JsonStore;

beforeEach(async () => {
  tmp = await useTmpCwd();
  store = new JsonStore();
});

afterEach(async () => {
  await tmp.cleanup();
});

async function seedEpisode(name: string) {
  const campaign = await store.upsertCampaign({
    name: "C",
    creatorName: "N",
    company: "W",
    startDate: null,
  });
  return store.upsertEpisodeGroupByName({ campaignId: campaign.id, name, description: null });
}

describe("episode CRUD (store)", () => {
  it("creates an episode and lists it", async () => {
    const e = await seedEpisode("Bootcamp");
    const all = await store.listEpisodeGroups();
    expect(all.map((x) => x.name)).toContain("Bootcamp");
    expect(e.id).toBeTruthy();
  });

  it("renames an episode without touching video assignments", async () => {
    const e = await seedEpisode("Bootcamp");
    const v = await store.insertVideo(makeVideo({ episodeGroupId: e.id }));
    const renamed = await store.updateEpisodeGroup(e.id, { name: "Bootcamp diaries" });
    expect(renamed.id).toBe(e.id);
    expect(renamed.name).toBe("Bootcamp diaries");
    expect((await store.getVideo(v.id))?.episodeGroupId).toBe(e.id);
    // No duplicate created by the rename.
    expect((await store.listEpisodeGroups()).filter((x) => /Bootcamp/.test(x.name))).toHaveLength(1);
  });

  it("rejects renaming to an existing name", async () => {
    const a = await seedEpisode("A");
    await store.upsertEpisodeGroupByName({ campaignId: a.campaignId, name: "B", description: null });
    await expect(store.updateEpisodeGroup(a.id, { name: "B" })).rejects.toThrow(/already exists/);
  });

  it("deleting an episode moves videos to Unassigned and keeps them", async () => {
    const e = await seedEpisode("Doomed");
    const v1 = await store.insertVideo(makeVideo({ episodeGroupId: e.id }));
    const v2 = await store.insertVideo(
      makeVideo({ episodeGroupId: e.id, originalUrl: "https://www.tiktok.com/@x/video/2" }),
    );
    const { videosMoved } = await store.deleteEpisodeGroup(e.id, null);
    expect(videosMoved).toBe(2);
    expect((await store.listEpisodeGroups()).find((x) => x.id === e.id)).toBeUndefined();
    // Videos still exist, now unassigned.
    expect((await store.getVideo(v1.id))?.episodeGroupId).toBeNull();
    expect((await store.getVideo(v2.id))?.episodeGroupId).toBeNull();
  });

  it("deleting with a replacement reassigns videos to it", async () => {
    const a = await seedEpisode("From");
    const b = await store.upsertEpisodeGroupByName({
      campaignId: a.campaignId,
      name: "To",
      description: null,
    });
    const v = await store.insertVideo(makeVideo({ episodeGroupId: a.id }));
    const { videosMoved } = await store.deleteEpisodeGroup(a.id, b.id);
    expect(videosMoved).toBe(1);
    expect((await store.getVideo(v.id))?.episodeGroupId).toBe(b.id);
  });

  it("rejects deleting into itself or into a missing replacement", async () => {
    const e = await seedEpisode("Solo");
    await expect(store.deleteEpisodeGroup(e.id, e.id)).rejects.toThrow();
    await expect(store.deleteEpisodeGroup(e.id, "nope")).rejects.toThrow(/not found/i);
  });
});

describe("episode mutation routes require admin auth (source-level)", () => {
  it("create route is guarded", () => {
    const src = read("src/app/api/admin/episodes/route.ts");
    expect(src).toContain("guardAdmin");
  });
  it("rename/delete route is guarded for both methods", () => {
    const src = read("src/app/api/admin/episodes/[id]/route.ts");
    expect(src.match(/guardAdmin/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
  it("video episode-assignment route is guarded", () => {
    const src = read("src/app/api/videos/[id]/episode/route.ts");
    expect(src).toContain("checkAdminRequest");
    expect(src).toContain("401");
  });
});

describe("public Episodes page is read-only and database-backed", () => {
  const page = read("src/app/episodes/page.tsx");
  it("renders no assignment controls and posts nothing", () => {
    expect(page).not.toContain("AssignEpisodeSelect");
    expect(page).not.toContain("fetch(");
    expect(page).not.toContain("/api/");
  });
  it("reads episodes from the database query layer (not hardcoded lists)", () => {
    expect(page).toContain("getEpisodesPageData");
    expect(page).not.toContain("DEFAULT_EPISODE_GROUPS");
  });
});

describe("auto-assignment never overwrites manual assignment", () => {
  it("the refresh update path never patches episodeGroupId on existing videos", () => {
    const refresh = read("src/lib/refresh.ts");
    const updateBlock = refresh.slice(
      refresh.indexOf("if (existing) {"),
      refresh.indexOf("// Campaign rule"),
    );
    expect(updateBlock).not.toContain("episodeGroupId");
  });
  it("caption inference only runs for newly inserted videos", () => {
    const refresh = read("src/lib/refresh.ts");
    const idx = refresh.indexOf("inferEpisodeGroup(");
    expect(idx).toBeGreaterThan(refresh.indexOf("// Campaign rule"));
  });
});
