// Storage interface implemented by the Postgres (Prisma) store and the local
// JSON file store. All app code talks to this interface only.

import type {
  Alert,
  AlertStatus,
  Campaign,
  Comment,
  EpisodeGroup,
  ManualOverride,
  MetricSnapshot,
  Platform,
  PlatformProfile,
  ProviderConfig,
  RefreshRun,
  Video,
} from "../types";

export interface StoreInfo {
  kind: "postgres" | "json";
  /** True when writes will not survive (e.g. JSON store on Vercel /tmp). */
  ephemeral: boolean;
  detail: string;
}

export interface VideoFilter {
  platform?: Platform;
  episodeGroupId?: string;
  includeHidden?: boolean;
}

export interface CommentFilter {
  platform?: Platform;
  videoId?: string;
  limit?: number;
}

export interface Store {
  info(): StoreInfo;

  // Campaign (single-campaign app; "the" campaign)
  getCampaign(): Promise<Campaign | null>;
  upsertCampaign(c: Omit<Campaign, "id" | "createdAt" | "updatedAt"> & { id?: string }): Promise<Campaign>;
  updateCampaign(id: string, patch: Partial<Pick<Campaign, "name" | "startDate">>): Promise<Campaign>;

  // Profiles
  listProfiles(): Promise<PlatformProfile[]>;
  upsertProfileByUrl(p: Omit<PlatformProfile, "id"> & { id?: string }): Promise<PlatformProfile>;
  updateProfile(id: string, patch: Partial<PlatformProfile>): Promise<PlatformProfile>;

  // Videos
  listVideos(filter?: VideoFilter): Promise<Video[]>;
  getVideo(id: string): Promise<Video | null>;
  findVideoByUrlOrExternalId(
    platform: Platform,
    originalUrl: string | null,
    externalVideoId: string | null,
  ): Promise<Video | null>;
  insertVideo(v: Omit<Video, "id"> & { id?: string }): Promise<Video>;
  updateVideo(id: string, patch: Partial<Video>): Promise<Video>;

  // Metric snapshots
  addSnapshot(s: Omit<MetricSnapshot, "id"> & { id?: string }): Promise<MetricSnapshot>;
  listSnapshots(videoId: string, sinceIso?: string): Promise<MetricSnapshot[]>;
  listAllSnapshots(sinceIso?: string): Promise<MetricSnapshot[]>;

  // Comments
  upsertComment(c: Omit<Comment, "id"> & { id?: string }): Promise<{ comment: Comment; created: boolean }>;
  listComments(filter?: CommentFilter): Promise<Comment[]>;

  // Refresh runs
  createRefreshRun(r: Omit<RefreshRun, "id"> & { id?: string }): Promise<RefreshRun>;
  updateRefreshRun(id: string, patch: Partial<RefreshRun>): Promise<RefreshRun>;
  listRefreshRuns(limit?: number): Promise<RefreshRun[]>;

  // Episode groups
  listEpisodeGroups(): Promise<EpisodeGroup[]>;
  upsertEpisodeGroupByName(
    e: Omit<EpisodeGroup, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<EpisodeGroup>;

  // Alerts
  listAlerts(status?: AlertStatus): Promise<Alert[]>;
  findOpenAlertByDedupeKey(key: string): Promise<Alert | null>;
  createAlert(a: Omit<Alert, "id"> & { id?: string }): Promise<Alert>;
  reviewAlert(id: string): Promise<Alert>;

  // Manual overrides (audit log)
  addOverride(o: Omit<ManualOverride, "id" | "createdAt"> & { id?: string }): Promise<ManualOverride>;
  listOverrides(limit?: number): Promise<ManualOverride[]>;

  // Provider configs
  listProviderConfigs(): Promise<ProviderConfig[]>;
  getProviderConfig(platform: Platform): Promise<ProviderConfig | null>;
  upsertProviderConfig(
    p: Omit<ProviderConfig, "id" | "updatedAt"> & { id?: string },
  ): Promise<ProviderConfig>;
}
