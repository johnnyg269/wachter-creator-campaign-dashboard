// Admin "Test Actor" flow: run a candidate actor against a seed URL, inspect
// the first items, detect capabilities, and persist the result on the
// platform's ProviderConfig. Bounded attempts — never hammers Apify.

import type { ActorTestResult, Platform, ProviderConfig } from "../types";
import type { Store } from "../store/types";
import { SEED_PROFILES, SEED_VIDEOS } from "../config";
import { ApifyError, runActor } from "./client";
import { buildInputCandidates, MAX_INPUT_ATTEMPTS, type FetchKind } from "./input-builder";
import { detectCapabilities, extractEmbeddedComments, normalizeVideoItem } from "./normalize";

export interface ActorTestOptions {
  platform: Platform;
  actorId: string;
  /** Defaults to the campaign seed video URL for the platform. */
  testUrl?: string;
  /** Verbatim input override (admin-provided JSON). */
  inputOverride?: unknown;
  /** Persist result to ProviderConfig (default true). */
  save?: boolean;
  store: Store;
}

export async function testActor(opts: ActorTestOptions): Promise<ActorTestResult> {
  const { platform, actorId, store } = opts;
  const seedVideo = SEED_VIDEOS.find((s) => s.platform === platform)?.url;
  const seedProfile = SEED_PROFILES.find((s) => s.platform === platform)?.url;
  const testUrl = opts.testUrl ?? seedVideo;
  const testedAt = new Date().toISOString();

  // YouTube's candidate actor is channel-based; everything else tests the
  // direct seed video URL first.
  const plans: Array<{ kind: FetchKind; ctx: Parameters<typeof buildInputCandidates>[3] }> =
    platform === "youtube"
      ? [{ kind: "discover", ctx: { profileUrl: seedProfile, limit: 10, override: opts.inputOverride } }]
      : [
          { kind: "videos", ctx: { videoUrls: testUrl ? [testUrl] : [], override: opts.inputOverride } },
          { kind: "discover", ctx: { profileUrl: seedProfile, limit: 5, override: opts.inputOverride } },
        ];

  let result: ActorTestResult = {
    ok: false,
    testedAt,
    inputUsed: null,
    inputDescription: "no input attempted",
    itemCount: 0,
    detectedFields: [],
    normalizedPreview: null,
    error: "Could not build any input for this actor",
    durationMs: null,
  };

  let attempts = 0;
  outer: for (const plan of plans) {
    const candidates = buildInputCandidates(platform, actorId, plan.kind, plan.ctx);
    for (const candidate of candidates) {
      if (attempts >= MAX_INPUT_ATTEMPTS) break outer;
      attempts++;
      try {
        const run = await runActor({
          actorId,
          input: candidate.input,
          timeoutMs: 180_000,
          maxItems: 25,
        });
        const caps = detectCapabilities(run.items, platform);
        const normalized = run.items
          .map((it) => normalizeVideoItem(it, platform))
          .find((n) => n !== null);
        result = {
          ok: run.items.length > 0 && Boolean(normalized),
          testedAt,
          inputUsed: candidate.input,
          inputDescription: candidate.description,
          itemCount: run.items.length,
          detectedFields: caps.fields,
          normalizedPreview: normalized ?? null,
          error:
            run.items.length === 0
              ? "Actor run succeeded but returned 0 items"
              : !normalized
                ? "Actor output could not be mapped to our video fields"
                : null,
          durationMs: run.durationMs,
        };
        if (result.ok) break outer;
      } catch (e) {
        const message = e instanceof ApifyError ? `${e.code}: ${e.message}` : String(e);
        result = { ...result, inputUsed: candidate.input, inputDescription: candidate.description, error: message };
        // Token/actor-level failures won't improve with other input shapes.
        if (e instanceof ApifyError && ["token_missing", "token_invalid", "actor_not_found"].includes(e.code)) {
          break outer;
        }
      }
    }
  }

  if (opts.save !== false) {
    const caps =
      result.ok && result.itemCount > 0
        ? {
            supportsMetadata: Boolean(
              result.normalizedPreview?.title ||
                result.normalizedPreview?.caption ||
                result.normalizedPreview?.thumbnailUrl,
            ),
            supportsMetrics:
              result.normalizedPreview?.views != null ||
              result.normalizedPreview?.likes != null ||
              result.normalizedPreview?.comments != null,
            supportsComments: hasEmbeddedComments(result),
            supportsDiscovery: platform === "youtube" ? true : Boolean(SEED_PROFILES.find((s) => s.platform === platform)),
          }
        : { supportsMetadata: false, supportsMetrics: false, supportsComments: false, supportsDiscovery: false };

    const existing = await store.getProviderConfig(platform);
    const config: Omit<ProviderConfig, "id" | "updatedAt"> = {
      platform,
      providerType: "apify",
      actorId,
      status: result.ok
        ? "live"
        : result.itemCount > 0
          ? "output_unmapped"
          : "actor_test_failed",
      lastTestedAt: testedAt,
      lastTestResult: sanitizeForStorage(result),
      detectedFields: result.detectedFields,
      ...caps,
      inputOverride: opts.inputOverride ?? existing?.inputOverride ?? null,
      lastSuccessfulRefreshAt: existing?.lastSuccessfulRefreshAt ?? null,
    };
    await store.upsertProviderConfig(config);
  }

  return result;
}

function hasEmbeddedComments(result: ActorTestResult): boolean {
  const raw = result.normalizedPreview?.rawJson;
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.commentsDatasetUrl === "string") return true;
  return extractEmbeddedComments(obj).length > 0;
}

/** Trim the rawJson blob so stored test results stay small. */
function sanitizeForStorage(result: ActorTestResult): ActorTestResult {
  if (!result.normalizedPreview) return result;
  return {
    ...result,
    normalizedPreview: { ...result.normalizedPreview, rawJson: undefined as unknown },
  };
}
