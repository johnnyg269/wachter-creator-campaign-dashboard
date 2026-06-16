// Alert generation. Runs at the end of every refresh. Each rule produces a
// dedupeKey so the same ongoing condition doesn't spam duplicate open alerts.

import type {
  Alert,
  AlertSeverity,
  AlertType,
  Campaign,
  Platform,
  Video,
} from "./types";
import { PLATFORM_LABELS } from "./types";
import type { Store } from "./store/types";
import {
  DAY_MS,
  HOUR_MS,
  computeVideoMetrics,
  deltaOverWindow,
  type VideoMetrics,
} from "./metrics";
import { formatCompact } from "./format";
import { campaignStartMs, isCampaignEligible, UNASSIGNED_EPISODE_NAME } from "./eligibility";

const SPIKE_MIN_HOURLY_VIEWS = 1000;
const SPIKE_RATIO = 4; // 1h pace vs avg hourly pace over prior 24h
const COMMENT_SPIKE_MIN = 8;
const HIGH_ER_THRESHOLD = 0.08;
const HIGH_ER_MIN_VIEWS = 1000;
const NO_POST_DAYS = 5;
const NEGATIVE_SPIKE_MIN = 3;

interface AlertDraft {
  type: AlertType;
  severity: AlertSeverity;
  platform: Platform | null;
  videoId: string | null;
  title: string;
  message: string;
  suggestedAction: string | null;
  dedupeKey: string;
}

async function emit(store: Store, campaign: Campaign, draft: AlertDraft): Promise<Alert | null> {
  const existing = await store.findOpenAlertByDedupeKey(draft.dedupeKey);
  if (existing) return null;
  return store.createAlert({
    campaignId: campaign.id,
    videoId: draft.videoId,
    platform: draft.platform,
    type: draft.type,
    severity: draft.severity,
    title: draft.title,
    message: draft.message,
    suggestedAction: draft.suggestedAction,
    createdAt: new Date().toISOString(),
    reviewedAt: null,
    status: "open",
    dedupeKey: draft.dedupeKey,
  });
}

function videoLabel(v: Video): string {
  return v.title ?? v.caption?.slice(0, 60) ?? `${PLATFORM_LABELS[v.platform]} video`;
}

/** Hour bucket so recurring conditions re-alert at most once per ~6h. */
function window6h(): string {
  return String(Math.floor(Date.now() / (6 * HOUR_MS)));
}

export async function generateAlerts(store: Store, campaign: Campaign): Promise<number> {
  // Only alert on eligible campaign content — never on quarantined / out-of-
  // campaign imports (mirrors the read-time filter in loadCampaignData).
  const episodes = await store.listEpisodeGroups();
  const unassignedId = episodes.find((e) => e.name === UNASSIGNED_EPISODE_NAME)?.id ?? null;
  const startMs = campaignStartMs();
  const videos = (await store.listVideos()).filter((v) =>
    isCampaignEligible(v, startMs, unassignedId),
  );
  let created = 0;

  for (const video of videos) {
    const snaps = await store.listSnapshots(video.id);
    if (snaps.length === 0) continue;
    const m = computeVideoMetrics(video, snaps);

    created += (await checkVideoSpike(store, campaign, video, m)) ? 1 : 0;
    created += (await checkCommentSpike(store, campaign, video, snaps.length, m)) ? 1 : 0;
    created += (await checkHighEngagement(store, campaign, video, m)) ? 1 : 0;
    created += (await checkMissingData(store, campaign, video, m)) ? 1 : 0;
  }

  created += await checkNegativeComments(store, campaign);
  created += await checkQuestions(store, campaign);
  created += await checkNoNewPosts(store, campaign, videos);

  return created;
}

async function checkVideoSpike(
  store: Store,
  campaign: Campaign,
  video: Video,
  m: VideoMetrics,
): Promise<boolean> {
  if (!m.delta1h || !m.delta1h.coversFullWindow) return false;
  const hourly = m.delta1h.value;
  if (hourly < SPIKE_MIN_HOURLY_VIEWS) return false;
  const day = m.delta24h?.value ?? null;
  const avgHourly = day !== null && day > 0 ? day / 24 : null;
  if (avgHourly !== null && hourly < avgHourly * SPIKE_RATIO) return false;
  const alert = await emit(store, campaign, {
    type: "video_spike",
    severity: "opportunity",
    platform: video.platform,
    videoId: video.id,
    title: `${PLATFORM_LABELS[video.platform]} video is gaining momentum`,
    message: `"${videoLabel(video)}" gained +${formatCompact(hourly)} views in the last hour.`,
    suggestedAction: "Consider boosting, cross-posting, or engaging in the comments while it's hot.",
    dedupeKey: `video_spike:${video.id}:${window6h()}`,
  });
  return alert !== null;
}

async function checkCommentSpike(
  store: Store,
  campaign: Campaign,
  video: Video,
  _snapCount: number,
  m: VideoMetrics,
): Promise<boolean> {
  const snaps = await store.listSnapshots(video.id);
  const d = deltaOverWindow(snaps, HOUR_MS, "comments");
  if (!d || !d.coversFullWindow || d.value < COMMENT_SPIKE_MIN) return false;
  const alert = await emit(store, campaign, {
    type: "comment_spike",
    severity: "opportunity",
    platform: video.platform,
    videoId: video.id,
    title: `Comment spike on ${PLATFORM_LABELS[video.platform]}`,
    message: `"${videoLabel(video)}" received +${d.value} comments in the last hour.`,
    suggestedAction: "Jump into the thread — fast replies compound reach.",
    dedupeKey: `comment_spike:${video.id}:${window6h()}`,
  });
  void m;
  return alert !== null;
}

async function checkHighEngagement(
  store: Store,
  campaign: Campaign,
  video: Video,
  m: VideoMetrics,
): Promise<boolean> {
  if (
    m.engagementRate === null ||
    m.engagementRate < HIGH_ER_THRESHOLD ||
    (m.latest?.views ?? 0) < HIGH_ER_MIN_VIEWS
  ) {
    return false;
  }
  const alert = await emit(store, campaign, {
    type: "high_engagement",
    severity: "opportunity",
    platform: video.platform,
    videoId: video.id,
    title: `High engagement rate on ${PLATFORM_LABELS[video.platform]}`,
    message: `"${videoLabel(video)}" is at ${(m.engagementRate * 100).toFixed(1)}% engagement with ${formatCompact(m.latest?.views ?? null)} views.`,
    suggestedAction: "Strong resonance — consider promoting this video or repurposing the concept.",
    dedupeKey: `high_engagement:${video.id}`,
  });
  return alert !== null;
}

async function checkMissingData(
  store: Store,
  campaign: Campaign,
  video: Video,
  m: VideoMetrics,
): Promise<boolean> {
  let created = false;
  if (!video.thumbnailUrl && video.lastRefreshedAt) {
    created =
      (await emit(store, campaign, {
        type: "missing_thumbnail",
        severity: "info",
        platform: video.platform,
        videoId: video.id,
        title: "Missing thumbnail",
        message: `"${videoLabel(video)}" has no thumbnail after refresh.`,
        suggestedAction: "Set one manually in /admin if the provider doesn't supply it.",
        dedupeKey: `missing_thumbnail:${video.id}`,
      })) !== null || created;
  }
  if (m.latest && m.latest.views === null && video.lastRefreshedAt) {
    created =
      (await emit(store, campaign, {
        type: "missing_metrics",
        severity: "warning",
        platform: video.platform,
        videoId: video.id,
        title: "Metrics unavailable",
        message: `"${videoLabel(video)}" refreshed without view counts — the source may not expose them.`,
        suggestedAction: "Check the provider configuration, or add a manual snapshot in /admin.",
        dedupeKey: `missing_metrics:${video.id}`,
      })) !== null || created;
  }
  return created;
}

async function checkNegativeComments(store: Store, campaign: Campaign): Promise<number> {
  const cutoff = new Date(Date.now() - DAY_MS).toISOString();
  const comments = await store.listComments();
  const recentNegative = comments.filter(
    (c) => c.sentiment === "negative" && (c.postedAt ?? c.capturedAt) >= cutoff,
  );
  const byVideo = new Map<string, number>();
  for (const c of recentNegative) byVideo.set(c.videoId, (byVideo.get(c.videoId) ?? 0) + 1);
  let created = 0;
  for (const [videoId, count] of byVideo) {
    if (count < NEGATIVE_SPIKE_MIN) continue;
    const video = await store.getVideo(videoId);
    if (!video) continue;
    const alert = await emit(store, campaign, {
      type: "negative_comment_spike",
      severity: "warning",
      platform: video.platform,
      videoId,
      title: "Negative comment cluster",
      message: `${count} negative comments on "${videoLabel(video)}" in the last 24h.`,
      suggestedAction: "Review the thread and decide whether a response is warranted.",
      dedupeKey: `negative_comment_spike:${videoId}:${window6h()}`,
    });
    if (alert) created++;
  }
  return created;
}

async function checkQuestions(store: Store, campaign: Campaign): Promise<number> {
  const cutoff = new Date(Date.now() - DAY_MS).toISOString();
  const comments = await store.listComments();
  const recentQuestions = comments.filter(
    (c) => c.needsResponse && (c.postedAt ?? c.capturedAt) >= cutoff,
  );
  const byVideo = new Map<string, number>();
  for (const c of recentQuestions) byVideo.set(c.videoId, (byVideo.get(c.videoId) ?? 0) + 1);
  let created = 0;
  for (const [videoId, count] of byVideo) {
    if (count < 2) continue;
    const video = await store.getVideo(videoId);
    if (!video) continue;
    const alert = await emit(store, campaign, {
      type: "question_needs_response",
      severity: "info",
      platform: video.platform,
      videoId,
      title: `${count} comments may deserve a response`,
      message: `"${videoLabel(video)}" has ${count} recent questions/comments flagged for response (training, hiring, pay, etc.).`,
      suggestedAction: "Open the Comments page, filter to this video, and reply where useful.",
      dedupeKey: `question_needs_response:${videoId}:${window6h()}`,
    });
    if (alert) created++;
  }
  return created;
}

async function checkNoNewPosts(
  store: Store,
  campaign: Campaign,
  videos: Video[],
): Promise<number> {
  let created = 0;
  const byPlatform = new Map<Platform, string | null>();
  for (const v of videos) {
    const cur = byPlatform.get(v.platform);
    const at = v.publishedAt ?? v.firstTrackedAt;
    if (cur === undefined || (at && (!cur || at > cur))) byPlatform.set(v.platform, at);
  }
  const cutoff = new Date(Date.now() - NO_POST_DAYS * DAY_MS).toISOString();
  for (const [platform, newest] of byPlatform) {
    if (!newest || newest >= cutoff) continue;
    const alert = await emit(store, campaign, {
      type: "no_new_posts",
      severity: "info",
      platform,
      videoId: null,
      title: `No new ${PLATFORM_LABELS[platform]} post in ${NO_POST_DAYS}+ days`,
      message: `The newest tracked ${PLATFORM_LABELS[platform]} video was published ${newest.slice(0, 10)}.`,
      suggestedAction: "Check the content calendar with the creator.",
      dedupeKey: `no_new_posts:${platform}:${String(Math.floor(Date.now() / DAY_MS))}`,
    });
    if (alert) created++;
  }
  return created;
}

/** Emitted by the refresh pipeline itself (not a scan rule). */
export async function emitRefreshFailureAlert(
  store: Store,
  campaign: Campaign,
  platform: Platform,
  reason: string,
): Promise<void> {
  await emit(store, campaign, {
    type: "refresh_failed",
    severity: "critical",
    platform,
    videoId: null,
    title: `${PLATFORM_LABELS[platform]} refresh failed`,
    message: reason.slice(0, 300),
    suggestedAction: "Check the Apify actor / credentials in /admin → Apify Setup.",
    dedupeKey: `refresh_failed:${platform}:${window6h()}`,
  });
}

/** Emitted when discovery finds a brand-new video. */
export async function emitNewVideoAlert(
  store: Store,
  campaign: Campaign,
  video: Video,
): Promise<void> {
  await emit(store, campaign, {
    type: "new_video",
    severity: "info",
    platform: video.platform,
    videoId: video.id,
    title: `New ${PLATFORM_LABELS[video.platform]} video discovered`,
    message: `"${videoLabel(video)}" was discovered and is now being tracked.`,
    suggestedAction: "Assign it to an episode in /admin or on the Videos page.",
    dedupeKey: `new_video:${video.id}`,
  });
}
