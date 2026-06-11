// Mock provider — LOCAL DEVELOPMENT ONLY. Active only when MOCK_DATA=1.
// Generates deterministic, clearly-labeled demo numbers so the UI can be
// designed without live sources. Every value it produces is tagged with
// sourceStatus "demo" and the UI shows a persistent DEMO banner.

import type {
  NormalizedComment,
  NormalizedVideo,
  Platform,
  PlatformProfile,
  Video,
} from "../types";
import { parseVideoUrl } from "../url-parse";
import type { ProviderReadiness, SocialPlatformProvider } from "./types";

/** Deterministic hash so demo numbers are stable per video. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

const DEMO_COMMENTS = [
  "How do I sign up for the bootcamp?",
  "What does a low voltage tech actually make per year?",
  "This is awesome, Wachter looks like a great place to work",
  "Do you need certifications before applying?",
  "Mount Laurel crew looking solid 🔥",
  "Is the training paid?",
  "What tools should I buy first?",
  "Been thinking about a career change, this might be it",
];

export class MockProvider implements SocialPlatformProvider {
  platform: Platform;
  providerType = "mock" as const;
  supportsComments = true;
  supportsDiscovery = false;
  supportsSavesOrBookmarks = true;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  readiness(): ProviderReadiness {
    return {
      ready: true,
      status: "working",
      sourceStatus: "demo",
      detail: "MOCK_DATA=1 — demo numbers, not real campaign data",
    };
  }

  private demoMetrics(key: string): Pick<
    NormalizedVideo,
    "views" | "likes" | "comments" | "shares" | "saves" | "bookmarks"
  > {
    const h = hash(key + this.platform);
    // Grows a little every 10-minute bucket so trend charts have a shape.
    const bucket = Math.floor(Date.now() / 600_000);
    const growth = (bucket % 1000) * (10 + (h % 50));
    const views = 5_000 + (h % 90_000) + growth;
    return {
      views,
      likes: Math.round(views * (0.04 + (h % 7) / 100)),
      comments: Math.round(views * 0.004),
      shares: Math.round(views * 0.002),
      saves: this.platform === "tiktok" ? Math.round(views * 0.003) : null,
      bookmarks: null,
    };
  }

  async discoverNewVideos(_profile: PlatformProfile, _since: Date): Promise<NormalizedVideo[]> {
    return [];
  }

  async getVideoMetadata(url: string): Promise<NormalizedVideo | null> {
    const parsed = parseVideoUrl(url);
    if (!parsed) return null;
    return {
      platform: this.platform,
      originalUrl: parsed.canonicalUrl,
      externalVideoId: parsed.externalVideoId,
      title: `[DEMO] ${this.platform} video`,
      caption: "[DEMO] Placeholder caption — enable real providers to replace",
      thumbnailUrl: null,
      publishedAt: null,
      authorName: "Cybernick0x",
      authorHandle: "cybernick0x",
      ...this.demoMetrics(url),
      rawJson: { demo: true },
    };
  }

  async getVideoMetrics(video: Video): Promise<NormalizedVideo | null> {
    return this.getVideoMetadata(video.originalUrl);
  }

  async getVideoComments(video: Video): Promise<NormalizedComment[]> {
    const h = hash(video.originalUrl);
    return DEMO_COMMENTS.slice(0, 3 + (h % 5)).map((text, i) => ({
      externalCommentId: `demo-${video.id}-${i}`,
      authorName: `demo_user_${(h + i) % 1000}`,
      text,
      postedAt: new Date(Date.now() - i * 3 * 3600_000).toISOString(),
      likes: (h + i * 7) % 40,
      replyCount: i % 3,
      permalink: null,
      rawJson: { demo: true },
    }));
  }
}
