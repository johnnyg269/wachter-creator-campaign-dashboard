// Shared test factories and sandbox helpers. Not itself a test file —
// vitest.config.ts only picks up tests/**/*.test.ts.

import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import { vi } from "vitest";
import type {
  Alert,
  Comment,
  MetricSnapshot,
  ProviderConfig,
  RefreshRun,
  Video,
} from "@/lib/types";

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function makeSnapshot(
  partial: Partial<MetricSnapshot> & { videoId: string; capturedAt: string },
): MetricSnapshot {
  return {
    id: nextId("snap"),
    views: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    bookmarks: null,
    engagementRate: null,
    rawJson: null,
    ...partial,
  };
}

export function makeVideo(partial: Partial<Video> = {}): Video {
  return {
    id: nextId("vid"),
    campaignId: "campaign-1",
    platform: "tiktok",
    profileId: null,
    originalUrl: `https://www.tiktok.com/@cybernick0x/video/${nextId("u")}`,
    externalVideoId: null,
    title: null,
    caption: null,
    thumbnailUrl: null,
    publishedAt: null,
    firstTrackedAt: "2026-06-01T00:00:00.000Z",
    lastRefreshedAt: null,
    status: "active",
    episodeGroupId: null,
    sourceStatus: "waiting",
    errorMessage: null,
    hidden: false,
    isSeed: false,
    rawJson: null,
    ...partial,
  };
}

export function makeComment(partial: Partial<Comment> & { videoId: string }): Comment {
  return {
    id: nextId("comment"),
    platform: "tiktok",
    externalCommentId: null,
    authorName: null,
    text: "test comment",
    postedAt: null,
    likes: null,
    replyCount: null,
    sentiment: null,
    needsResponse: false,
    tags: [],
    permalink: null,
    capturedAt: "2026-06-01T00:00:00.000Z",
    rawJson: null,
    ...partial,
  };
}

export function makeRefreshRun(partial: Partial<RefreshRun> = {}): RefreshRun {
  return {
    id: nextId("run"),
    startedAt: "2026-06-01T00:00:00.000Z",
    finishedAt: null,
    status: "running",
    trigger: "manual",
    platformsAttempted: [],
    videosUpdated: 0,
    commentsUpdated: 0,
    newVideosDiscovered: 0,
    errors: [],
    rawLog: null,
    ...partial,
  };
}

export function makeAlert(partial: Partial<Alert> = {}): Alert {
  return {
    id: nextId("alert"),
    campaignId: "campaign-1",
    videoId: null,
    platform: null,
    type: "manual_review",
    severity: "info",
    title: "Test alert",
    message: "Test alert message",
    suggestedAction: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    reviewedAt: null,
    status: "open",
    dedupeKey: null,
    ...partial,
  };
}

export function makeProviderConfig(partial: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: nextId("provider"),
    platform: "tiktok",
    providerType: "apify",
    actorId: null,
    status: "untested",
    lastTestedAt: null,
    lastTestResult: null,
    detectedFields: [],
    supportsMetadata: false,
    supportsMetrics: false,
    supportsComments: false,
    supportsDiscovery: false,
    inputOverride: null,
    lastSuccessfulRefreshAt: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
}

export interface TmpCwd {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Points process.cwd() at a fresh temp dir so JsonStore writes there instead
 * of the repo's ./data. Must be called before constructing the store.
 */
export async function useTmpCwd(): Promise<TmpCwd> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wachter-tests-"));
  const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  return {
    dir,
    cleanup: async () => {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Deletes the given env vars and returns a restore function. */
export function stashEnv(keys: string[]): () => void {
  const saved = new Map<string, string | undefined>();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
