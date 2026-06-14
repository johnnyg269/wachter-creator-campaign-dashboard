// Regression tests for the "deleted episode concept reappears at the bottom"
// bug. These would FAIL against the old ensureSeedData, which unconditionally
// re-seeded DEFAULT_EPISODE_GROUPS on every call (every page load + refresh)
// and recreated deleted concepts with a fresh id/createdAt.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "@/lib/store/json-store";
import { ensureSeedData } from "@/lib/seed";
import { DEFAULT_EPISODE_GROUPS } from "@/lib/config";
import { useTmpCwd, type TmpCwd } from "./helpers";

let tmp: TmpCwd;
let store: JsonStore;

beforeEach(async () => {
  tmp = await useTmpCwd();
  store = new JsonStore();
});
afterEach(async () => {
  await tmp.cleanup();
});

// Simulate the admin delete route: hard-delete + durable tombstone override.
async function adminDelete(name: string) {
  const ep = (await store.listEpisodeGroups()).find((e) => e.name === name);
  if (!ep) throw new Error(`no concept named ${name}`);
  await store.deleteEpisodeGroup(ep.id, null);
  await store.addOverride({
    entityType: "episode",
    entityId: ep.id,
    field: "deleted",
    oldValue: name,
    newValue: "0 videos → Unassigned",
    reason: null,
  });
  return ep.id;
}

describe("episode deletion is permanent", () => {
  it("seeds the defaults once on a fresh store", async () => {
    await ensureSeedData(store);
    const names = (await store.listEpisodeGroups()).map((e) => e.name).sort();
    expect(names).toEqual([...DEFAULT_EPISODE_GROUPS].sort());
  });

  it("a second ensureSeedData adds no duplicates (idempotent)", async () => {
    await ensureSeedData(store);
    const before = await store.listEpisodeGroups();
    await ensureSeedData(store);
    const after = await store.listEpisodeGroups();
    expect(after.length).toBe(before.length);
    expect(after.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
  });

  it("a deleted concept does NOT come back after ensureSeedData (page load / refresh)", async () => {
    await ensureSeedData(store);
    const deletedId = await adminDelete("Bootcamp");

    // getHealth / public Episodes / refresh all call ensureSeedData:
    await ensureSeedData(store);
    await ensureSeedData(store);

    const names = (await store.listEpisodeGroups()).map((e) => e.name);
    expect(names).not.toContain("Bootcamp");
    // and no NEW row with that name / a fresh id was created at the bottom
    const ids = (await store.listEpisodeGroups()).map((e) => e.id);
    expect(ids).not.toContain(deletedId);
    expect(names.filter((n) => n === "Bootcamp")).toHaveLength(0);
  });

  it("deletes stay gone even when only one concept is removed (others remain)", async () => {
    await ensureSeedData(store);
    await adminDelete("Tools and tech");
    await ensureSeedData(store);
    const names = (await store.listEpisodeGroups()).map((e) => e.name);
    expect(names).not.toContain("Tools and tech");
    expect(names.length).toBe(DEFAULT_EPISODE_GROUPS.length - 1);
  });

  it("tombstone blocks resurrection even when ALL concepts are deleted (zero-count reseed)", async () => {
    await ensureSeedData(store);
    for (const name of [...DEFAULT_EPISODE_GROUPS]) await adminDelete(name);
    expect(await store.listEpisodeGroups()).toHaveLength(0);

    await ensureSeedData(store); // zero concepts — but every name is tombstoned
    expect(await store.listEpisodeGroups()).toHaveLength(0);
  });

  it("a concept recreated after deletion is NOT re-tombstoned (latest action wins)", async () => {
    await ensureSeedData(store);
    const id = await adminDelete("Wachter culture");
    // admin re-creates the same name (route writes a `created` override):
    const campaign = await store.getCampaign();
    const revived = await store.upsertEpisodeGroupByName({
      campaignId: campaign!.id,
      name: "Wachter culture",
      description: null,
    });
    await store.addOverride({
      entityType: "episode",
      entityId: revived.id,
      field: "created",
      oldValue: null,
      newValue: "Wachter culture",
      reason: null,
    });
    expect(revived.id).not.toBe(id);
    // delete everything, then reseed: "Wachter culture"'s latest action is
    // `created`, so it is NOT tombstoned and may seed; others stay gone.
    await ensureSeedData(store);
    const names = (await store.listEpisodeGroups()).map((e) => e.name);
    expect(names).toContain("Wachter culture");
  });

  it("assigned-video delete reassigns members (videos never deleted)", async () => {
    await ensureSeedData(store);
    const ep = (await store.listEpisodeGroups())[0];
    const videos = await store.listVideos({ includeHidden: true });
    const v = videos[0];
    await store.updateVideo(v.id, { episodeGroupId: ep.id });
    const { videosMoved } = await store.deleteEpisodeGroup(ep.id, null);
    expect(videosMoved).toBe(1);
    expect((await store.getVideo(v.id))?.episodeGroupId).toBeNull();
    expect((await store.listEpisodeGroups()).some((e) => e.id === ep.id)).toBe(false);
  });
});
