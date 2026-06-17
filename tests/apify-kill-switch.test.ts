// Apify spend kill switch (Parts 3–6) + TikTok valid_unverified thumbnail state
// (Parts 7–8). Proves that with the safe defaults Apify is never attached as a
// fallback, the per-config gate requires explicit opt-in AND positive caps, the
// admin status surfaces the disabled state + today's Apify usage (no secrets /
// actor IDs), and the thumbnail state machine stores TikTok covers as
// valid_unverified, renders them directly, and never churns retries on them.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apifyFallbackAllowedByConfig,
  getApifyDailyRunCap,
  getApifyDailySpendCapUsd,
  isApifyFallbackEnabled,
} from "@/lib/config";
import { resolveProvider } from "@/lib/providers/registry";
import { isTikTokCdnHost, thumbSrc } from "@/lib/thumb-proxy";
import {
  initialThumbState,
  nextThumbnailState,
  MAX_THUMBNAIL_RETRIES,
  type ThumbnailState,
} from "@/lib/thumbnail-state";
import type { Store } from "@/lib/store/types";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

// Snapshot + restore every env key the kill switch / routing reads.
const ENV_KEYS = [
  "APIFY_FALLBACK_ENABLED",
  "APIFY_DAILY_SPEND_CAP_USD",
  "APIFY_DAILY_RUN_CAP",
  "APIFY_TOKEN",
  "APIFY_TIKTOK_ACTOR_ID",
  "MOCK_DATA",
  "SOCIALCRAWL_API_KEY",
  "SOCIALCRAWL_METRICS_ENABLED",
  "NON_YOUTUBE_METRICS_PROVIDER",
  "YOUTUBE_API_KEY",
] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const fakeStore = { getProviderConfig: async () => null } as unknown as Store;
// FallbackProvider keeps `fallback`/`canFallback` private — read them at runtime.
const fbState = (p: unknown) => p as unknown as { canFallback: boolean; fallback: unknown };

// ── Config kill switch (Part 3) ───────────────────────────────────────────────
describe("Apify config flags default to OFF", () => {
  it("isApifyFallbackEnabled is false unless explicitly '1'/'true'", () => {
    expect(isApifyFallbackEnabled()).toBe(false);
    process.env.APIFY_FALLBACK_ENABLED = "1";
    expect(isApifyFallbackEnabled()).toBe(true);
    process.env.APIFY_FALLBACK_ENABLED = "true";
    expect(isApifyFallbackEnabled()).toBe(true);
    process.env.APIFY_FALLBACK_ENABLED = "false";
    expect(isApifyFallbackEnabled()).toBe(false);
    process.env.APIFY_FALLBACK_ENABLED = "0";
    expect(isApifyFallbackEnabled()).toBe(false);
  });

  it("spend + run caps default to 0 and parse non-negative numbers", () => {
    expect(getApifyDailySpendCapUsd()).toBe(0);
    expect(getApifyDailyRunCap()).toBe(0);
    process.env.APIFY_DAILY_SPEND_CAP_USD = "2.5";
    process.env.APIFY_DAILY_RUN_CAP = "10";
    expect(getApifyDailySpendCapUsd()).toBe(2.5);
    expect(getApifyDailyRunCap()).toBe(10);
    process.env.APIFY_DAILY_SPEND_CAP_USD = "garbage";
    expect(getApifyDailySpendCapUsd()).toBe(0); // invalid → off
  });

  it("apifyFallbackAllowedByConfig needs enabled AND both caps > 0", () => {
    expect(apifyFallbackAllowedByConfig()).toBe(false); // all defaults

    process.env.APIFY_FALLBACK_ENABLED = "true"; // enabled but caps still 0
    expect(apifyFallbackAllowedByConfig()).toBe(false);

    process.env.APIFY_DAILY_SPEND_CAP_USD = "5"; // run cap still 0
    expect(apifyFallbackAllowedByConfig()).toBe(false);

    process.env.APIFY_DAILY_RUN_CAP = "20"; // now all three satisfied
    expect(apifyFallbackAllowedByConfig()).toBe(true);

    process.env.APIFY_FALLBACK_ENABLED = "false"; // master off wins over caps
    expect(apifyFallbackAllowedByConfig()).toBe(false);
  });
});

// ── Registry gate (Parts 3–5) ─────────────────────────────────────────────────
describe("resolveProvider never attaches Apify when disabled", () => {
  const enableSocialcrawl = () => {
    process.env.SOCIALCRAWL_API_KEY = "sc_test";
    process.env.SOCIALCRAWL_METRICS_ENABLED = "true";
    process.env.NON_YOUTUBE_METRICS_PROVIDER = "socialcrawl";
  };

  it("TikTok routes to SocialCrawl with NO Apify fallback by default (token + actor present)", async () => {
    enableSocialcrawl();
    process.env.APIFY_TOKEN = "test-token"; // even with token + actor configured…
    process.env.APIFY_TIKTOK_ACTOR_ID = "GdWCkxBtKWOsKjdch";
    const r = await resolveProvider("tiktok", fakeStore); // …config gate is OFF
    expect(r.provider.providerType).toBe("socialcrawl");
    expect(fbState(r.provider).canFallback).toBe(false);
    expect(fbState(r.provider).fallback).toBeNull();
  });

  it("attaches the Apify fallback only when explicitly allowed (override true)", async () => {
    enableSocialcrawl();
    process.env.APIFY_TOKEN = "test-token";
    process.env.APIFY_TIKTOK_ACTOR_ID = "GdWCkxBtKWOsKjdch";
    const r = await resolveProvider("tiktok", fakeStore, true); // runtime says OK
    expect(fbState(r.provider).canFallback).toBe(true);
    expect(fbState(r.provider).fallback).not.toBeNull();
  });

  it("an explicit override=false blocks Apify even if config would allow it", async () => {
    enableSocialcrawl();
    process.env.APIFY_TOKEN = "test-token";
    process.env.APIFY_TIKTOK_ACTOR_ID = "GdWCkxBtKWOsKjdch";
    process.env.APIFY_FALLBACK_ENABLED = "true";
    process.env.APIFY_DAILY_SPEND_CAP_USD = "5";
    process.env.APIFY_DAILY_RUN_CAP = "20"; // config would allow…
    const r = await resolveProvider("tiktok", fakeStore, false); // …runtime cap reached
    expect(fbState(r.provider).canFallback).toBe(false);
    expect(fbState(r.provider).fallback).toBeNull();
  });

  it("YouTube stays on the Data API regardless of Apify flags", async () => {
    process.env.YOUTUBE_API_KEY = "yt_test";
    const r = await resolveProvider("youtube", fakeStore);
    expect(r.provider.providerType).toBe("youtube_api");
  });
});

// ── Admin visibility (Part 6) — source-level, no secrets ───────────────────────
describe("admin surfaces Apify disabled + usage without leaking secrets", () => {
  it("SocialcrawlAdminStatus carries the disabled flag + today's call/spend (no key/token/actor field)", () => {
    const q = read("src/lib/queries.ts");
    const start = q.indexOf("interface SocialcrawlAdminStatus");
    const block = q.slice(start, q.indexOf("}", start));
    expect(block).toContain("apifyFallbackEnabled");
    expect(block).toContain("apifyCallsToday");
    expect(block).toContain("apifyEstSpendToday");
    // No field that would carry a secret or a provider-internal actor id.
    expect(block).not.toMatch(/\bapi[_]?key\s*:/i);
    expect(block).not.toMatch(/\btoken\s*:/i);
    expect(block).not.toMatch(/actorId\s*:/i);
  });

  it("admin page renders ENABLED/disabled state and the off-by-default note", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).toContain("data.socialcrawl.apifyFallbackEnabled");
    expect(page).toMatch(/Apify fallback:/);
    expect(page).toMatch(/Off by default/);
    expect(page).toContain("apifyCallsToday");
    expect(page).toContain("apifyEstSpendToday");
  });

  it("the Apify visibility code carries no actor-id literals", () => {
    // Known Apify actor handles must not appear in the status query or the
    // admin readiness rows (they live only in the gated Apify-setup config).
    const ACTOR_IDS = ["GdWCkxBtKWOsKjdch", "xMc5Ga1oCONPmWJIa"];
    for (const f of ["src/app/admin/page.tsx", "src/lib/queries.ts"]) {
      const src = read(f);
      for (const id of ACTOR_IDS) expect(src).not.toContain(id);
    }
  });
});

// ── TikTok valid_unverified thumbnail state (Parts 7–8) ────────────────────────
describe("TikTok thumbnail valid_unverified state machine", () => {
  const fresh = (over: Partial<ThumbnailState> = {}): ThumbnailState => ({
    status: "missing", attempts: 0, lastAttemptAt: null, nextRetryAt: null,
    failureReason: null, resolvedFrom: null, ...over,
  });
  const now = "2026-06-16T12:00:00.000Z";

  it("stores an unverifiable (TikTok CDN) URL as valid_unverified", () => {
    const r = nextThumbnailState({
      resolvedUrl: "https://p16.tiktokcdn-us.com/cover.heic", existingUrl: null,
      prev: fresh(), isDiscovery: true, now, verifiable: false,
    });
    expect(r.thumbnailUrl).toBe("https://p16.tiktokcdn-us.com/cover.heic");
    expect(r.thumb.status).toBe("valid_unverified");
    expect(r.thumb.attempts).toBe(0);
  });

  it("stores a server-verifiable URL as valid", () => {
    const r = nextThumbnailState({
      resolvedUrl: "https://scontent.cdninstagram.com/x.jpg", existingUrl: null,
      prev: fresh(), isDiscovery: true, now, verifiable: true,
    });
    expect(r.thumb.status).toBe("valid");
  });

  it("does NOT retry a valid_unverified thumbnail when a later pull has none", () => {
    const prev = fresh({ status: "valid_unverified", resolvedFrom: "provider", lastAttemptAt: now });
    const r = nextThumbnailState({
      resolvedUrl: null, existingUrl: "https://p16.tiktokcdn-us.com/cover.heic",
      prev, isDiscovery: true, now: "2026-06-16T13:00:00.000Z",
    });
    expect(r.thumbnailUrl).toBe("https://p16.tiktokcdn-us.com/cover.heic"); // preserved
    expect(r.thumb).toBe(prev); // untouched — no attempt counted
  });

  it("never overwrites a manual thumbnail", () => {
    const prev = fresh({ status: "valid", resolvedFrom: "manual" });
    const r = nextThumbnailState({
      resolvedUrl: "https://p16.tiktokcdn-us.com/new.heic", existingUrl: "https://admin/set.jpg",
      prev, isDiscovery: true, now, verifiable: false,
    });
    expect(r.thumbnailUrl).toBe("https://admin/set.jpg");
  });

  it("a truly-missing thumbnail still retries (discovery-paced) and caps out", () => {
    let prev = fresh();
    for (let i = 1; i <= MAX_THUMBNAIL_RETRIES; i++) {
      const r = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev, isDiscovery: true, now });
      prev = r.thumb;
      expect(prev.attempts).toBe(i);
    }
    expect(prev.status).toBe("failed"); // stops after MAX
    // A failed state is sticky — no further attempts.
    const after = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev, isDiscovery: true, now });
    expect(after.thumb.attempts).toBe(MAX_THUMBNAIL_RETRIES);
  });

  it("metrics-only (non-discovery) pulls never count toward the retry cap", () => {
    const prev = fresh({ status: "missing" });
    const r = nextThumbnailState({ resolvedUrl: null, existingUrl: null, prev, isDiscovery: false, now });
    expect(r.thumb.attempts).toBe(0);
  });

  it("initialThumbState seeds a new TikTok cover as valid_unverified (no later churn)", () => {
    const r = initialThumbState({ thumbnailUrl: "https://p16.tiktokcdn-us.com/c.heic", now, verifiable: false });
    expect(r.thumbnailUrl).toBe("https://p16.tiktokcdn-us.com/c.heic");
    expect(r.thumb.status).toBe("valid_unverified");
    // A follow-up pull with no thumbnail leaves it untouched (no retry counted).
    const next = nextThumbnailState({
      resolvedUrl: null, existingUrl: r.thumbnailUrl, prev: r.thumb, isDiscovery: true, now,
    });
    expect(next.thumb).toBe(r.thumb);
  });

  it("initialThumbState seeds a missing cover as retry_pending (attempts 0)", () => {
    const r = initialThumbState({ thumbnailUrl: null, now });
    expect(r.thumbnailUrl).toBeNull();
    expect(r.thumb.status).toBe("retry_pending");
    expect(r.thumb.attempts).toBe(0);
  });
});

// ── TikTok rendering: direct (not proxied), placeholder fallback (Part 7C) ──────
describe("TikTok CDN thumbnails are rendered directly, not proxied", () => {
  it("isTikTokCdnHost matches the signed TikTok image CDNs", () => {
    expect(isTikTokCdnHost("https://p16.tiktokcdn-us.com/x.heic")).toBe(true);
    expect(isTikTokCdnHost("https://p16-common-sign.tiktokcdn-us.com/y.jpeg")).toBe(true);
    expect(isTikTokCdnHost("https://cdn.tiktokcdn-eu.com/z.jpg")).toBe(true);
    expect(isTikTokCdnHost("https://scontent.cdninstagram.com/a.jpg")).toBe(false);
    expect(isTikTokCdnHost(null)).toBe(false);
  });

  it("thumbSrc returns the raw https URL for TikTok (browser loads it), proxies IG/FB", () => {
    const tt = "https://p16.tiktokcdn-us.com/cover.heic";
    expect(thumbSrc(tt)).toBe(tt); // NOT /api/thumb — TikTok blocks server fetch
    expect(thumbSrc("https://scontent.cdninstagram.com/x.jpg")).toMatch(/^\/api\/thumb\?src=/);
    expect(thumbSrc(null)).toBeNull();
  });
});
