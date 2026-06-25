// Campaign Phase 1: model + tagging (schema-free rawJson), migration default
// (existing → MTL), remove-from-tracking (soft delete), campaign filter
// chokepoint (All / MTL / Bootcamp, no double-count), and the discovery guard
// that never re-adds an admin-excluded video.

import { readFileSync } from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  videoCampaign,
  videoTrackingStatus,
  matchesCampaign,
  isAdminExcluded,
  campaignAssignmentPatch,
  trackingPatch,
  parseCampaignFilter,
  parsePublicCampaignFilter,
  CAMPAIGNS,
} from "@/lib/campaigns";
import { makeVideo } from "./helpers";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");
const withRaw = (raw: unknown) => makeVideo({ rawJson: raw as never });

// ── Model + helpers ────────────────────────────────────────────────────────
describe("campaign model + tagging", () => {
  it("defines an active MTL campaign and an archived Bootcamp campaign", () => {
    expect(CAMPAIGNS.find((c) => c.slug === "mtl")?.status).toBe("active");
    const bc = CAMPAIGNS.find((c) => c.slug === "bootcamp");
    expect(bc?.status).toBe("archived");
    expect(bc?.defaultRefreshTier).toBe("daily");
  });

  it("MIGRATION DEFAULT: an untagged, non-excluded video counts as MTL", () => {
    expect(videoCampaign(withRaw(null))).toBe("mtl");
    expect(videoCampaign(withRaw({ source: "socialcrawl" }))).toBe("mtl");
  });

  it("respects an explicit campaign tag (mtl / bootcamp / unassigned)", () => {
    expect(videoCampaign(withRaw({ campaign: "mtl" }))).toBe("mtl");
    expect(videoCampaign(withRaw({ campaign: "bootcamp" }))).toBe("bootcamp");
    expect(videoCampaign(withRaw({ campaign: "unassigned" }))).toBeNull();
  });

  it("an admin-excluded video is never auto-MTL (campaign null, status excluded)", () => {
    const v = withRaw({ tracking: { status: "excluded", reason: "off-campaign" } });
    expect(isAdminExcluded(v)).toBe(true);
    expect(videoCampaign(v)).toBeNull();
    expect(videoTrackingStatus(v)).toBe("excluded");
  });

  it("EXCLUSION DOMINATES an explicit tag (exclude-then-tag never leaks)", () => {
    // Regression: a video excluded AND still carrying campaign:"mtl" must resolve
    // to null so the "all" filter drops it everywhere (incl. the includeHidden
    // alerts path), not surface under MTL.
    const v = withRaw({ campaign: "mtl", tracking: { status: "excluded", reason: "x" } });
    expect(videoCampaign(v)).toBeNull();
    expect(matchesCampaign(videoCampaign(v), "all")).toBe(false);
  });

  it("tracking status reflects review candidates and active state", () => {
    expect(videoTrackingStatus(withRaw({ discoveryReview: true }))).toBe("review");
    expect(videoTrackingStatus(withRaw(null))).toBe("active");
  });
});

// ── Filter semantics (no double-count) ───────────────────────────────────────
describe("matchesCampaign filter", () => {
  it("All = any assigned campaign; excludes unassigned/excluded (null)", () => {
    expect(matchesCampaign("mtl", "all")).toBe(true);
    expect(matchesCampaign("bootcamp", "all")).toBe(true);
    expect(matchesCampaign(null, "all")).toBe(false);
  });
  it("MTL / Bootcamp select only their own; a video is in exactly one", () => {
    expect(matchesCampaign("mtl", "mtl")).toBe(true);
    expect(matchesCampaign("mtl", "bootcamp")).toBe(false);
    expect(matchesCampaign("bootcamp", "bootcamp")).toBe(true);
    expect(matchesCampaign("bootcamp", "mtl")).toBe(false);
    // No double-count: a bootcamp video matches bootcamp + all, never mtl.
    const inFilters = (["all", "mtl", "bootcamp", "unassigned"] as const).filter((f) => matchesCampaign("bootcamp", f));
    expect(inFilters).toEqual(["all", "bootcamp"]);
  });
  it("unassigned filter selects only null-campaign videos (admin)", () => {
    expect(matchesCampaign(null, "unassigned")).toBe(true);
    expect(matchesCampaign("mtl", "unassigned")).toBe(false);
  });
  it("parseCampaignFilter defaults to all and rejects junk", () => {
    expect(parseCampaignFilter(undefined)).toBe("all");
    expect(parseCampaignFilter("mtl")).toBe("mtl");
    expect(parseCampaignFilter("nonsense")).toBe("all");
  });
  it("parsePublicCampaignFilter collapses admin-only 'unassigned' to 'all'", () => {
    expect(parsePublicCampaignFilter("unassigned")).toBe("all"); // never public
    expect(parsePublicCampaignFilter("bootcamp")).toBe("bootcamp");
    expect(parsePublicCampaignFilter("mtl")).toBe("mtl");
    expect(parsePublicCampaignFilter(undefined)).toBe("all");
  });
});

// ── rawJson patches ──────────────────────────────────────────────────────────
describe("campaign + tracking rawJson patches", () => {
  it("campaignAssignmentPatch sets the slug, preserving other rawJson", () => {
    const out = campaignAssignmentPatch({ thumb: { status: "valid" } }, "bootcamp");
    expect(out.campaign).toBe("bootcamp");
    expect(out.thumb).toEqual({ status: "valid" }); // not clobbered
  });
  it("trackingPatch exclude/restore records status + audit metadata", () => {
    const ex = trackingPatch(null, "exclude", { reason: "spam", now: "2026-06-18T00:00:00Z" });
    expect((ex.tracking as { status: string }).status).toBe("excluded");
    expect((ex.tracking as { reason: string }).reason).toBe("spam");
    const re = trackingPatch(ex, "restore", { now: "2026-06-19T00:00:00Z" });
    expect((re.tracking as { status: string }).status).toBe("active");
  });
});

// ── Chokepoint integration: filter scopes loadCampaignData ──────────────────
import { loadCampaignData } from "@/lib/queries";
import { ensureSeedData } from "@/lib/seed";
import { getStore } from "@/lib/store";
import { useTmpCwd, type TmpCwd } from "./helpers";

describe("loadCampaignData campaign scoping (integration)", () => {
  let tmp: TmpCwd;
  const reset = () => ((globalThis as unknown as { __wachterStore?: unknown }).__wachterStore = undefined);
  beforeEach(async () => { tmp = await useTmpCwd(); reset(); process.env.CAMPAIGN_START_DATE_ET = "2026-06-08"; });
  afterEach(async () => { reset(); delete process.env.CAMPAIGN_START_DATE_ET; await tmp.cleanup(); });

  const insert = async (slug: string | null, opts: { excluded?: boolean } = {}) => {
    const store = getStore();
    const c = await ensureSeedData(store);
    const raw: Record<string, unknown> = {};
    if (slug) raw.campaign = slug;
    if (opts.excluded) raw.tracking = { status: "excluded", reason: "x" };
    return store.insertVideo({
      campaignId: c.id, platform: "tiktok", profileId: null,
      originalUrl: `https://www.tiktok.com/@x/video/${slug ?? "unset"}-${Math.round(Math.random() * 1e9)}`,
      externalVideoId: `${slug ?? "unset"}-${Math.round(Math.random() * 1e9)}`,
      title: `v-${slug}`, caption: null, thumbnailUrl: null,
      publishedAt: "2026-06-12T00:00:00.000Z", firstTrackedAt: "2026-06-12T00:00:00.000Z",
      lastRefreshedAt: "2026-06-12T00:00:00.000Z", status: "active", episodeGroupId: null,
      sourceStatus: "live", errorMessage: null, hidden: Boolean(opts.excluded), isSeed: false,
      rawJson: Object.keys(raw).length ? (raw as never) : null,
    });
  };

  it("MTL filter returns mtl + untagged (migration default); not bootcamp/unassigned/excluded", async () => {
    const store = getStore();
    const mtl = await insert("mtl");
    const unset = await insert(null);
    const boot = await insert("bootcamp");
    const unassigned = await insert("unassigned");
    const excluded = await insert("mtl", { excluded: true });

    const mtlData = await loadCampaignData(false, "mtl");
    const ids = new Set(mtlData.videos.map((v) => v.id));
    expect(ids.has(mtl.id)).toBe(true);
    expect(ids.has(unset.id)).toBe(true); // default MTL
    expect(ids.has(boot.id)).toBe(false);
    expect(ids.has(unassigned.id)).toBe(false);
    expect(ids.has(excluded.id)).toBe(false); // removed from tracking
    // scoped videos carry the derived campaign (rawJson is stripped)
    expect(mtlData.videos.find((v) => v.id === mtl.id)?.campaign).toBe("mtl");
    expect(mtlData.videos.every((v) => v.rawJson === null)).toBe(true);
    void store;
  });

  it("Bootcamp filter returns only bootcamp videos", async () => {
    const boot = await insert("bootcamp");
    const mtl = await insert("mtl");
    const data = await loadCampaignData(false, "bootcamp");
    const ids = new Set(data.videos.map((v) => v.id));
    expect(ids.has(boot.id)).toBe(true);
    expect(ids.has(mtl.id)).toBe(false);
  });

  it("All = MTL + Bootcamp with NO double-count; excludes excluded + unassigned", async () => {
    const mtl = await insert("mtl");
    const boot = await insert("bootcamp");
    const unassigned = await insert("unassigned");
    const excluded = await insert("bootcamp", { excluded: true });
    const data = await loadCampaignData(false, "all");
    const ids = data.videos.map((v) => v.id);
    expect(ids.filter((id) => id === mtl.id)).toHaveLength(1); // no dup
    expect(ids).toContain(boot.id);
    expect(ids).not.toContain(unassigned.id);
    expect(ids).not.toContain(excluded.id);
  });

  it("an excluded video is gone from public totals but visible to admin (unscoped)", async () => {
    const excluded = await insert("mtl", { excluded: true });
    const pub = await loadCampaignData(false, "all");
    expect(pub.videos.some((v) => v.id === excluded.id)).toBe(false);
    const admin = await loadCampaignData(true, "all", true); // adminUnscoped
    const row = admin.videos.find((v) => v.id === excluded.id);
    expect(row).toBeDefined();
    expect(row?.trackingStatus).toBe("excluded");
  });

  it("excluded video is dropped even on the includeHidden non-admin path (alerts)", async () => {
    // /alerts uses loadCampaignData(true) (includeHidden, NOT adminUnscoped).
    // Defense-in-depth must drop excluded videos there too — including an
    // exclude-then-tagged one (campaign:'mtl' + tracking excluded).
    const excluded = await insert("mtl", { excluded: true });
    const data = await loadCampaignData(true, "all"); // includeHidden, non-admin
    expect(data.videos.some((v) => v.id === excluded.id)).toBe(false);
  });
});

// ── Safety: admin API + discovery guard + no leaks ──────────────────────────
describe("campaign safety + admin wiring (source-level)", () => {
  it("video PATCH route accepts campaign + tracking (reason required to exclude)", () => {
    const src = read("src/app/api/admin/videos/[id]/route.ts");
    expect(src).toMatch(/campaignAssignmentPatch/);
    expect(src).toMatch(/trackingPatch/);
    expect(src).toMatch(/reason is required to remove a video from tracking/);
  });
  it("bulk route exists and is admin-gated", () => {
    const src = read("src/app/api/admin/videos/bulk/route.ts");
    expect(src).toMatch(/guardAdmin/);
    expect(src).toMatch(/"assign"|'assign'/);
  });
  it("discovery never re-adds an admin-excluded video", () => {
    expect(read("src/lib/refresh.ts")).toMatch(/isAdminExcluded\(existing\)/);
  });
  it("scoped videos never carry rawJson to the client", () => {
    // loadCampaignData maps rawJson:null after deriving campaign/trackingStatus.
    expect(read("src/lib/queries.ts")).toMatch(/campaign: videoCampaign\(v\)/);
    expect(read("src/lib/queries.ts")).toMatch(/rawJson: null/);
  });
});
