// Regression for the incident: a metrics refresh rewrites rawJson from the
// provider payload, which carries no campaign tag. Without carrying the admin/
// campaign keys over, every refresh stripped a Bootcamp video's tag → it reverted
// to the MTL default → being pre-MTL-floor it was dropped from all totals. These
// tests lock in that the carry-over helper preserves campaign/tracking and that
// the refresh write path actually uses it.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { carryOverAdminTags, campaignTag, isAdminExcluded } from "@/lib/campaigns";

const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf-8");

describe("carryOverAdminTags", () => {
  it("preserves the campaign tag when a provider payload (no tag) is written", () => {
    const existing = { campaign: "bootcamp", thumb: { status: "valid" } };
    const fresh = { views: 999, author: "x" }; // provider payload — no campaign key
    const merged = carryOverAdminTags(existing, fresh);
    expect(campaignTag({ rawJson: merged })).toBe("bootcamp");
    expect(merged.views).toBe(999); // provider fields kept
  });

  it("preserves tracking (excluded) and discovery-review flags", () => {
    const existing = { campaign: "mtl", tracking: { status: "excluded", reason: "x" }, discoveryReview: true };
    const merged = carryOverAdminTags(existing, { views: 5 });
    expect(isAdminExcluded({ rawJson: merged })).toBe(true);
    expect(merged.discoveryReview).toBe(true);
  });

  it("does not invent admin keys the existing record never had", () => {
    const merged = carryOverAdminTags({}, { campaign: "bootcamp", tracking: { status: "excluded" } });
    // A provider payload must never be able to assert a campaign/exclusion itself.
    expect(merged.campaign).toBeUndefined();
    expect(merged.tracking).toBeUndefined();
  });

  it("falls back cleanly when existing rawJson is null/non-object", () => {
    expect(carryOverAdminTags(null, { views: 1 })).toEqual({ views: 1 });
    expect(carryOverAdminTags(undefined, null)).toEqual({});
  });
});

describe("refresh write path wiring (source-level)", () => {
  it("upsertFetchedVideo carries admin tags over the provider rawJson", () => {
    const src = read("src/lib/refresh.ts");
    // The existing-video update must run the provider payload through carryOverAdminTags.
    expect(src).toMatch(/carryOverAdminTags\(existing\.rawJson, n\.rawJson \?\? existing\.rawJson\)/);
    // And it must NOT write the bare provider payload directly any more.
    expect(src).not.toMatch(/mergeThumbIntoRaw\(n\.rawJson \?\? existing\.rawJson, ts\.thumb\)/);
  });
});
