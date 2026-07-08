// Manual comment catch-up: default targets = hot MTL on SocialCrawl platforms
// (never YouTube/excluded/bootcamp-by-default); pulls + upserts + dedups comments,
// bounded by maxCredits, logging one billable attempt per fetch.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commentCatchupTargets, runCommentCatchup } from "@/lib/comment-catchup";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import type { NormalizedComment, Platform, Video } from "@/lib/types";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

const nc = (id: string, text: string): NormalizedComment => ({
  externalCommentId: id, authorName: "a", text, postedAt: "2026-07-01T00:00:00.000Z",
  likes: 1, replyCount: 0, permalink: null, rawJson: null,
} as NormalizedComment);

describe("comment catch-up", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE", "HOT_VIDEO_AGE_DAYS"]);
    process.env.CAMPAIGN_START_DATE_ET = "2024-01-01";
    process.env.BOOTCAMP_START_DATE = "2024-01-01";
    process.env.HOT_VIDEO_AGE_DAYS = "7";
  });
  afterEach(async () => {
    reset();
    restore();
    await tmp.cleanup();
  });

  let n = 0;
  const ins = (store: ReturnType<typeof getStore>, cid: string, over: Record<string, unknown>) =>
    store.insertVideo({
      campaignId: cid, platform: "tiktok", profileId: null,
      originalUrl: `https://x/${++n}`, externalVideoId: `e${n}`, title: "v", caption: null, thumbnailUrl: null,
      publishedAt: new Date().toISOString(), firstTrackedAt: new Date().toISOString(),
      lastRefreshedAt: null, status: "active", episodeGroupId: null, sourceStatus: "live",
      errorMessage: null, hidden: false, isSeed: false, rawJson: { campaign: "mtl" } as never,
      ...over,
    } as Parameters<typeof store.insertVideo>[0]);

  it("default targets = hot MTL on SC platforms; excludes YouTube, excluded, and bootcamp", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const hot = await ins(store, c.id, {}); // hot MTL tiktok ✓
    const yt = await ins(store, c.id, { platform: "youtube", originalUrl: "https://youtube/x" }); // YouTube ✗
    const bootcamp = await ins(store, c.id, { rawJson: { campaign: "bootcamp" } }); // bootcamp ✗ (default)
    const excluded = await ins(store, c.id, { hidden: true, rawJson: { campaign: "mtl", tracking: { status: "excluded", reason: "x" } } }); // ✗
    const warm = await ins(store, c.id, { publishedAt: "2026-01-01T00:00:00.000Z" }); // warm MTL ✗

    const ids = new Set(commentCatchupTargets(await store.listVideos({ includeHidden: true }), {}, new Date()).map((v) => v.id));
    expect(ids.has(hot.id)).toBe(true);
    for (const bad of [yt.id, bootcamp.id, excluded.id, warm.id]) expect(ids.has(bad)).toBe(false);
    // explicit bootcamp scope opts bootcamp videos in (and never the excluded one)
    const bc = new Set(commentCatchupTargets(await store.listVideos({ includeHidden: true }), { campaign: "bootcamp" }, new Date()).map((v) => v.id));
    expect(bc.has(bootcamp.id)).toBe(true);
    expect(bc.has(excluded.id)).toBe(false);
  });

  it("pulls + upserts comments, dedups, respects maxCredits, logs attempts", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await ins(store, c.id, {}); await ins(store, c.id, {}); await ins(store, c.id, {});
    const resolveComments = async (_p: Platform, _v: Video) => [nc(`cm-${_v.id}`, "love this, how do I apply?")];
    const res = await runCommentCatchup(store, { resolveComments, scope: { maxCredits: 2 } });
    expect(res.creditsUsed).toBe(2); // bounded by maxCredits
    expect(res.processed).toBe(2);
    expect(res.commentsAdded).toBe(2);
    const atts = await store.listCollectionAttempts(20);
    expect(atts.filter((a) => a.provider === "socialcrawl" && /comment-catchup/.test(a.inputDescription)).length).toBe(2);
    // re-run over the same videos → duplicates, none added
    const res2 = await runCommentCatchup(store, { resolveComments, scope: { maxCredits: 2 } });
    expect(res2.commentsAdded).toBe(0);
    expect(res2.duplicates).toBe(2);
  });

  it("a null/failed resolve counts as a credit + failure but adds nothing (no wipe)", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await ins(store, c.id, {});
    const res = await runCommentCatchup(store, { resolveComments: async () => null, scope: { maxCredits: 5 } });
    expect(res.processed).toBeGreaterThanOrEqual(1);
    expect(res.failed).toBe(res.processed); // every resolve returned null
    expect(res.creditsUsed).toBe(res.processed);
    expect(res.commentsAdded).toBe(0);
  });
});
