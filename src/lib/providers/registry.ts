// Provider resolution per platform:
//   MOCK_DATA=1            → MockProvider (local dev, clearly labeled)
//   youtube + YOUTUBE_API_KEY → YouTubeApiProvider (official API preferred)
//   APIFY token + actor    → ApifyProvider
//   otherwise              → ManualProvider (with an explanatory status)

import {
  apifyFallbackAllowedByConfig,
  getActorIdFromEnv,
  getApifyToken,
  getYouTubeApiKey,
  isMockMode,
  metricsProviderFor,
} from "../config";
import type { Platform, ProviderConfig, SourceStatus } from "../types";
import type { Store } from "../store/types";
import { ApifyProvider } from "./apify-provider";
import { ManualProvider } from "./manual-provider";
import { MockProvider } from "./mock-provider";
import { YouTubeApiProvider } from "./youtube-api-provider";
import { SocialCrawlProvider } from "./socialcrawl-provider";
import { FallbackProvider } from "./fallback-provider";
import type { ProviderReadiness, SocialPlatformProvider } from "./types";

export interface ResolvedProvider {
  provider: SocialPlatformProvider;
  readiness: ProviderReadiness;
  config: ProviderConfig | null;
}

export async function resolveProvider(
  platform: Platform,
  store: Store,
  /** Runtime override: whether Apify may run right now (config gate + today's
   *  cap). Defaults to the config-only gate (used by health/status display). */
  apifyAllowedOverride?: boolean,
): Promise<ResolvedProvider> {
  if (isMockMode()) {
    const provider = new MockProvider(platform);
    return { provider, readiness: provider.readiness(), config: null };
  }

  const config = await store.getProviderConfig(platform);
  const apifyAllowed = apifyAllowedOverride ?? apifyFallbackAllowedByConfig();

  if (platform === "youtube" && getYouTubeApiKey()) {
    const provider = new YouTubeApiProvider();
    return { provider, readiness: provider.readiness(), config };
  }

  // SocialCrawl primary (TikTok/Instagram/Facebook) when enabled + selected.
  // Apify is attached as a fallback ONLY when it's explicitly allowed (off by
  // default) AND an actor is configured; otherwise a SocialCrawl failure
  // preserves last-known-good rather than spending on Apify.
  if (platform !== "youtube" && metricsProviderFor(platform) === "socialcrawl") {
    const primary = new SocialCrawlProvider(platform);
    const hasApifyActor = Boolean(config?.actorId?.trim() || getActorIdFromEnv(platform));
    const apifyFallback = apifyAllowed && getApifyToken() && hasApifyActor ? new ApifyProvider(platform, config) : null;
    const provider = new FallbackProvider(primary, apifyFallback, apifyFallback !== null);
    return { provider, readiness: primary.readiness(), config };
  }

  const hasActor = Boolean(config?.actorId?.trim() || getActorIdFromEnv(platform));
  if (apifyAllowed && getApifyToken() && hasActor) {
    const provider = new ApifyProvider(platform, config);
    return { provider, readiness: provider.readiness(), config };
  }

  // Not connected — figure out the most helpful status to show.
  const manual = new ManualProvider(platform);
  let sourceStatus: SourceStatus;
  let detail: string;
  if (!getApifyToken()) {
    if (platform === "youtube") {
      sourceStatus = "needs_api_key";
      detail = "Set YOUTUBE_API_KEY or APIFY_TOKEN + a YouTube actor";
    } else {
      sourceStatus = "needs_apify_token";
      detail = "Set APIFY_TOKEN in .env.local / Vercel env vars";
    }
  } else {
    sourceStatus = "actor_not_configured";
    detail = "Apify token connected — assign an actor in /admin → Apify Setup";
  }
  return {
    provider: manual,
    readiness: {
      ready: false,
      status: !getApifyToken() ? "token_missing" : "actor_missing",
      sourceStatus,
      detail,
    },
    config,
  };
}

export async function resolveAllProviders(store: Store): Promise<Record<Platform, ResolvedProvider>> {
  const [tiktok, youtube, instagram, facebook] = await Promise.all([
    resolveProvider("tiktok", store),
    resolveProvider("youtube", store),
    resolveProvider("instagram", store),
    resolveProvider("facebook", store),
  ]);
  return { tiktok, youtube, instagram, facebook };
}
