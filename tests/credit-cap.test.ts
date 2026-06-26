// Today-only SocialCrawl credit-cap override (schema-free, ManualOverride row):
// active override raises today's cap, auto-expires at the next ET midnight, then
// resolves back to the env default. Tolerant of missing/garbage/expired rows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveCapOverride, resolveCreditCap, setCapOverride } from "@/lib/credit-cap";
import { getStore } from "@/lib/store";
import { useTmpCwd, stashEnv, type TmpCwd } from "./helpers";

describe("credit-cap today-only override", () => {
  let tmp: TmpCwd;
  let restore: () => void;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => {
    tmp = await useTmpCwd();
    reset();
    restore = stashEnv(["SOCIALCRAWL_DAILY_CREDIT_CAP"]);
    process.env.SOCIALCRAWL_DAILY_CREDIT_CAP = "350";
  });
  afterEach(async () => {
    reset();
    restore();
    await tmp.cleanup();
  });

  it("no override → base env cap (350)", async () => {
    const r = await resolveCreditCap(getStore(), new Date("2026-06-25T12:00:00Z"));
    expect(r).toMatchObject({ activeCap: 350, baseCap: 350, override: null });
  });

  it("active override raises today's cap; expiry is after now", async () => {
    const store = getStore();
    const now = new Date("2026-06-25T18:00:00Z"); // 14:00 ET
    const o = await setCapOverride(store, { value: 600, reason: "fill pending bootcamp", now });
    expect(o.value).toBe(600);
    expect(Date.parse(o.expiresAtIso)).toBeGreaterThan(now.getTime());
    const r = await resolveCreditCap(store, now);
    expect(r.activeCap).toBe(600);
    expect(r.baseCap).toBe(350);
    expect(r.override?.value).toBe(600);
    expect(r.override?.reason).toBe("fill pending bootcamp");
  });

  it("after the ET-midnight expiry → reverts to base (override ignored tomorrow)", async () => {
    const store = getStore();
    await setCapOverride(store, { value: 600, now: new Date("2026-06-25T18:00:00Z") });
    const tomorrow = new Date("2026-06-26T20:00:00Z"); // well past tonight's ET midnight
    const r = await resolveCreditCap(store, tomorrow);
    expect(r.activeCap).toBe(350);
    expect(r.override).toBeNull();
  });

  it("garbage/invalid override row → base (tolerant)", async () => {
    const store = getStore();
    await store.addOverride({ entityType: "config", entityId: "socialcrawl_credit_cap", field: "daily_cap_override", oldValue: "350", newValue: "not-json", reason: "x" });
    expect(await getActiveCapOverride(store, new Date("2026-06-25T18:00:00Z"))).toBeNull();
    expect((await resolveCreditCap(store, new Date("2026-06-25T18:00:00Z"))).activeCap).toBe(350);
  });

  it("the newest override wins (a fresh 350 supersedes an earlier 600)", async () => {
    const store = getStore();
    const now = new Date("2026-06-25T18:00:00Z");
    await setCapOverride(store, { value: 600, now });
    await setCapOverride(store, { value: 350, now: new Date(now.getTime() + 60_000) });
    expect((await resolveCreditCap(store, new Date(now.getTime() + 120_000))).activeCap).toBe(350);
  });
});
