// Comment-health diagnostic: comment text is gated to hot MTL AND a SocialCrawl
// comment budget (cap − usedToday − reserve). These lock in that (a) hot MTL is
// counted eligible, (b) Bootcamp/cold/excluded are skipped with reasons, and
// (c) when the cap is reached the diagnostic flags capReached + explains the
// TT/IG/FB starvation (the incident root cause).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCommentHealth } from "@/lib/comment-health";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

describe("computeCommentHealth", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["CAMPAIGN_START_DATE_ET", "BOOTCAMP_START_DATE", "SOCIALCRAWL_DAILY_CREDIT_CAP", "HOT_VIDEO_AGE_DAYS"]);
    process.env.CAMPAIGN_START_DATE_ET = "2024-01-01";
    process.env.BOOTCAMP_START_DATE = "2024-01-01";
    process.env.SOCIALCRAWL_DAILY_CREDIT_CAP = "350";
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

  it("counts hot MTL as comment-eligible; bootcamp/cold/excluded skipped by reason", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await ins(store, c.id, {}); // fresh MTL → hot → eligible
    await ins(store, c.id, { publishedAt: "2026-01-01T00:00:00.000Z" }); // old MTL → warm → skipped (cold off)
    await ins(store, c.id, { rawJson: { campaign: "bootcamp" } }); // bootcamp → skipped (bootcamp off)
    await ins(store, c.id, { hidden: true, rawJson: { campaign: "mtl", tracking: { status: "excluded", reason: "x" } } }); // excluded

    const h = await computeCommentHealth(store, new Date());
    expect(h.eligibility.tierCounts.mtl_hot).toBeGreaterThanOrEqual(1);
    expect(h.eligibility.eligibleForComments).toBeGreaterThanOrEqual(1);
    expect(h.eligibility.skipReasons.cold_warm_comments_disabled).toBeGreaterThanOrEqual(1);
    expect(h.eligibility.skipReasons.bootcamp_comments_disabled).toBeGreaterThanOrEqual(1);
    expect(h.eligibility.skipReasons.excluded_removed).toBeGreaterThanOrEqual(1);
  });

  it("staleness: fresh <24h → ok; >24h → warning; >72h (or never) → critical, with a reason", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const v = await ins(store, c.id, {});
    const mk = (capturedAt: string) =>
      store.upsertComment({ videoId: v.id, platform: "tiktok", externalCommentId: `c-${capturedAt}`, authorName: "a", text: "hi", postedAt: null, likes: 0, replyCount: 0, sentiment: null, needsResponse: false, tags: [], permalink: null, capturedAt, rawJson: null });
    const now = new Date("2026-07-14T12:00:00.000Z");
    // never pulled → critical
    expect((await computeCommentHealth(store, now)).staleness.level).toBe("critical");
    await mk("2026-07-10T12:00:00.000Z"); // 96h ago → still critical
    expect((await computeCommentHealth(store, now)).staleness.level).toBe("critical");
    await mk("2026-07-13T00:00:00.000Z"); // 36h ago → warning
    const warn = await computeCommentHealth(store, now);
    expect(warn.staleness.level).toBe("warning");
    expect(warn.staleness.reason).not.toBe("fresh");
    await mk("2026-07-14T06:00:00.000Z"); // 6h ago → ok (public totals untouched by warnings)
    expect((await computeCommentHealth(store, now)).staleness.level).toBe("ok");
  });

  it("flags capReached + explains TT/IG/FB starvation when the daily cap is consumed", async () => {
    const store = getStore();
    const c = await ensureSeedData(store);
    await ins(store, c.id, {}); // an eligible hot MTL video exists
    // Burn the SocialCrawl cap for today via logged attempts (351 >= 350).
    const now = new Date().toISOString();
    for (let i = 0; i < 351; i++) {
      await store.addCollectionAttempt({
        refreshRunId: null, platform: "tiktok", provider: "socialcrawl", actorId: null, kind: "metrics",
        inputDescription: "socialcrawl tiktok · 1cr · cache:miss", success: true, runId: null, itemCount: 1, error: null, capturedAt: now,
      });
    }
    const h = await computeCommentHealth(store, new Date());
    expect(h.credits.usedToday).toBeGreaterThanOrEqual(350);
    expect(h.credits.commentBudgetNow).toBe(0);
    expect(h.credits.capReached).toBe(true);
    expect(h.eligibility.eligibleForComments).toBeGreaterThanOrEqual(1); // eligible BUT starved
    expect(h.explanation).toMatch(/cap is reached|SKIPPED|cap contention/i);
  });
});
