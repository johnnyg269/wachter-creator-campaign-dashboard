// Thumbnail retry state machine (schema-free — persisted in Video.rawJson.thumb).
//
// The provider thumbnail picker already tries every cover/image field and rejects
// placeholders, video URLs, and HEIC (see socialcrawl-provider pickThumbnail).
// This tracks WHAT to do when no usable thumbnail is available yet: retry on the
// next DISCOVERY pull (not every 15-min metrics run), cap at a few attempts so we
// never retry forever, never overwrite a good/manual thumbnail, and never block a
// valid video from being tracked just because its thumbnail is missing.

export type ThumbnailStatus = "valid" | "missing" | "retry_pending" | "failed" | "placeholder";

export interface ThumbnailState {
  status: ThumbnailStatus;
  attempts: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  failureReason: string | null;
  /** "provider" | "manual" | null — manual is never overwritten automatically. */
  resolvedFrom: string | null;
}

export const MAX_THUMBNAIL_RETRIES = 3;

export function readThumbState(rawJson: unknown): ThumbnailState {
  const t =
    rawJson && typeof rawJson === "object"
      ? (rawJson as { thumb?: Partial<ThumbnailState> }).thumb
      : null;
  return {
    status: (t?.status as ThumbnailStatus) ?? "missing",
    attempts: typeof t?.attempts === "number" ? t.attempts : 0,
    lastAttemptAt: t?.lastAttemptAt ?? null,
    nextRetryAt: t?.nextRetryAt ?? null,
    failureReason: t?.failureReason ?? null,
    resolvedFrom: t?.resolvedFrom ?? null,
  };
}

/**
 * Decide the stored thumbnail + retry state for a refresh cycle.
 * - resolvedUrl: a usable thumbnail from the provider THIS pull (picker-validated) or null.
 * - existingUrl: the currently stored thumbnail.
 * - prev: previous thumb state.
 * - isDiscovery: only discovery pulls count toward the retry cap.
 */
export function nextThumbnailState(args: {
  resolvedUrl: string | null;
  existingUrl: string | null;
  prev: ThumbnailState;
  isDiscovery: boolean;
  now: string;
}): { thumbnailUrl: string | null; thumb: ThumbnailState } {
  const { resolvedUrl, existingUrl, prev, isDiscovery, now } = args;

  // Never auto-overwrite an admin-set (manual) thumbnail.
  if (prev.resolvedFrom === "manual" && existingUrl) {
    return { thumbnailUrl: existingUrl, thumb: prev };
  }
  // Provider gave a usable thumbnail → use it, reset retry state.
  if (resolvedUrl) {
    return {
      thumbnailUrl: resolvedUrl,
      thumb: { status: "valid", attempts: 0, lastAttemptAt: now, nextRetryAt: null, failureReason: null, resolvedFrom: "provider" },
    };
  }
  // No provider thumbnail this pull — keep the last-known-good one untouched.
  if (existingUrl && prev.status === "valid") {
    return { thumbnailUrl: existingUrl, thumb: prev };
  }
  // Retries exhausted — keep a clean placeholder, stop trying.
  if (prev.status === "failed") {
    return { thumbnailUrl: existingUrl ?? null, thumb: prev };
  }
  // Still missing. Count an attempt only on discovery pulls; cap at MAX.
  const attempts = prev.attempts + (isDiscovery ? 1 : 0);
  const status: ThumbnailStatus = attempts >= MAX_THUMBNAIL_RETRIES ? "failed" : "retry_pending";
  return {
    thumbnailUrl: existingUrl ?? null,
    thumb: {
      status,
      attempts,
      lastAttemptAt: isDiscovery ? now : prev.lastAttemptAt,
      nextRetryAt: status === "retry_pending" ? "next discovery pull" : null,
      failureReason: "No usable thumbnail in provider response",
      resolvedFrom: prev.resolvedFrom,
    },
  };
}

/** Merge a thumb state into a rawJson object without losing the provider payload. */
export function mergeThumbIntoRaw(rawJson: unknown, thumb: ThumbnailState): Record<string, unknown> {
  const base = rawJson && typeof rawJson === "object" ? { ...(rawJson as Record<string, unknown>) } : {};
  base.thumb = thumb;
  return base;
}
