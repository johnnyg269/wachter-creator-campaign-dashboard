// Postgres store via Prisma. Used when DATABASE_URL is set (Supabase).
// Mirrors JsonStore semantics exactly: upsert-by-natural-key, comment dedupe,
// sorting, and limits. Domain types use ISO-8601 strings; Prisma uses Date —
// the to-domain / to-db mappers below convert at the boundary.

import { Prisma, PrismaClient } from "@prisma/client";
import type {
  Alert as DbAlert,
  Campaign as DbCampaign,
  Comment as DbComment,
  EpisodeGroup as DbEpisodeGroup,
  ManualOverride as DbOverride,
  MetricSnapshot as DbSnapshot,
  PlatformProfile as DbProfile,
  ProviderConfig as DbProviderConfig,
  RefreshRun as DbRefreshRun,
  Video as DbVideo,
} from "@prisma/client";
import type {
  ActorTestResult,
  Alert,
  AlertSeverity,
  AlertStatus,
  AlertType,
  Campaign,
  Comment,
  EpisodeGroup,
  ManualOverride,
  MetricSnapshot,
  Platform,
  PlatformProfile,
  ProviderConfig,
  ProviderStatusValue,
  ProviderType,
  RefreshRun,
  Sentiment,
  SourceStatus,
  Video,
  VideoStatus,
} from "../types";
import type { CommentFilter, Store, StoreInfo, VideoFilter } from "./types";

// ── Prisma client singleton (standard Next.js pattern) ──────────────────────

const g = globalThis as unknown as { __prisma?: PrismaClient };

function prismaClient(): PrismaClient {
  if (!g.__prisma) g.__prisma = new PrismaClient();
  return g.__prisma;
}

// ── Date / JSON boundary helpers ─────────────────────────────────────────────

function iso(d: Date): string {
  return d.toISOString();
}

function isoOrNull(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

function toDate(s: string): Date {
  return new Date(s);
}

function toDateOrNull(s: string | null): Date | null {
  return s ? new Date(s) : null;
}

/** For Partial<> patches: undefined = leave unchanged, null = set NULL. */
function patchDate(s: string | null | undefined): Date | null | undefined {
  if (s === undefined) return undefined;
  return s === null ? null : new Date(s);
}

type JsonIn = Prisma.InputJsonValue | typeof Prisma.JsonNull;

/** Domain null/undefined is stored as JSON null. */
function toJsonIn(v: unknown): JsonIn {
  return v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
}

/** For Partial<> patches: undefined = leave unchanged. */
function patchJson(v: unknown): JsonIn | undefined {
  return v === undefined ? undefined : toJsonIn(v);
}

// ── Row → domain mappers ─────────────────────────────────────────────────────

function campaignToDomain(row: DbCampaign): Campaign {
  return {
    id: row.id,
    name: row.name,
    creatorName: row.creatorName,
    company: row.company,
    startDate: isoOrNull(row.startDate),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function profileToDomain(row: DbProfile): PlatformProfile {
  return {
    id: row.id,
    campaignId: row.campaignId,
    platform: row.platform as Platform,
    profileUrl: row.profileUrl,
    handle: row.handle,
    externalProfileId: row.externalProfileId,
    lastDiscoveredAt: isoOrNull(row.lastDiscoveredAt),
    status: row.status as SourceStatus,
  };
}

function videoToDomain(row: DbVideo): Video {
  return {
    id: row.id,
    campaignId: row.campaignId,
    platform: row.platform as Platform,
    profileId: row.profileId,
    originalUrl: row.originalUrl,
    externalVideoId: row.externalVideoId,
    title: row.title,
    caption: row.caption,
    thumbnailUrl: row.thumbnailUrl,
    publishedAt: isoOrNull(row.publishedAt),
    firstTrackedAt: iso(row.firstTrackedAt),
    lastRefreshedAt: isoOrNull(row.lastRefreshedAt),
    status: row.status as VideoStatus,
    episodeGroupId: row.episodeGroupId,
    sourceStatus: row.sourceStatus as SourceStatus,
    errorMessage: row.errorMessage,
    hidden: row.hidden,
    isSeed: row.isSeed,
    rawJson: row.rawJson ?? null,
  };
}

function snapshotToDomain(row: DbSnapshot): MetricSnapshot {
  return {
    id: row.id,
    videoId: row.videoId,
    capturedAt: iso(row.capturedAt),
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    saves: row.saves,
    bookmarks: row.bookmarks,
    engagementRate: row.engagementRate,
    rawJson: row.rawJson ?? null,
  };
}

function commentToDomain(row: DbComment): Comment {
  return {
    id: row.id,
    videoId: row.videoId,
    platform: row.platform as Platform,
    externalCommentId: row.externalCommentId,
    authorName: row.authorName,
    text: row.text,
    postedAt: isoOrNull(row.postedAt),
    likes: row.likes,
    replyCount: row.replyCount,
    sentiment: row.sentiment as Sentiment | null,
    needsResponse: row.needsResponse,
    tags: row.tags,
    permalink: row.permalink,
    capturedAt: iso(row.capturedAt),
    rawJson: row.rawJson ?? null,
  };
}

function refreshRunToDomain(row: DbRefreshRun): RefreshRun {
  return {
    id: row.id,
    startedAt: iso(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    status: row.status as RefreshRun["status"],
    trigger: row.trigger as RefreshRun["trigger"],
    platformsAttempted: row.platformsAttempted as Platform[],
    videosUpdated: row.videosUpdated,
    commentsUpdated: row.commentsUpdated,
    newVideosDiscovered: row.newVideosDiscovered,
    errors: row.errors,
    rawLog: row.rawLog,
  };
}

function episodeGroupToDomain(row: DbEpisodeGroup): EpisodeGroup {
  return {
    id: row.id,
    campaignId: row.campaignId,
    name: row.name,
    description: row.description,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function alertToDomain(row: DbAlert): Alert {
  return {
    id: row.id,
    campaignId: row.campaignId,
    videoId: row.videoId,
    platform: row.platform as Platform | null,
    type: row.type as AlertType,
    severity: row.severity as AlertSeverity,
    title: row.title,
    message: row.message,
    suggestedAction: row.suggestedAction,
    createdAt: iso(row.createdAt),
    reviewedAt: isoOrNull(row.reviewedAt),
    status: row.status as AlertStatus,
    dedupeKey: row.dedupeKey,
  };
}

function overrideToDomain(row: DbOverride): ManualOverride {
  return {
    id: row.id,
    entityType: row.entityType as ManualOverride["entityType"],
    entityId: row.entityId,
    field: row.field,
    oldValue: row.oldValue,
    newValue: row.newValue,
    reason: row.reason,
    createdAt: iso(row.createdAt),
  };
}

function providerConfigToDomain(row: DbProviderConfig): ProviderConfig {
  return {
    id: row.id,
    platform: row.platform as Platform,
    providerType: row.providerType as ProviderType,
    actorId: row.actorId,
    status: row.status as ProviderStatusValue,
    lastTestedAt: isoOrNull(row.lastTestedAt),
    lastTestResult: (row.lastTestResult ?? null) as ActorTestResult | null,
    detectedFields: row.detectedFields,
    supportsMetadata: row.supportsMetadata,
    supportsMetrics: row.supportsMetrics,
    supportsComments: row.supportsComments,
    supportsDiscovery: row.supportsDiscovery,
    inputOverride: row.inputOverride ?? null,
    lastSuccessfulRefreshAt: isoOrNull(row.lastSuccessfulRefreshAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ── Store implementation ─────────────────────────────────────────────────────

export class PrismaStore implements Store {
  /** Lazy — never constructs PrismaClient unless a query actually runs. */
  private get prisma(): PrismaClient {
    return prismaClient();
  }

  info(): StoreInfo {
    return { kind: "postgres", ephemeral: false, detail: "Supabase/Postgres via Prisma" };
  }

  // ── Campaign ───────────────────────────────────────────────────────────────

  async getCampaign(): Promise<Campaign | null> {
    const row = await this.prisma.campaign.findFirst({ orderBy: { createdAt: "asc" } });
    return row ? campaignToDomain(row) : null;
  }

  async upsertCampaign(
    c: Omit<Campaign, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<Campaign> {
    const row = await this.prisma.campaign.upsert({
      where: { name: c.name },
      update: { creatorName: c.creatorName, company: c.company },
      create: {
        id: c.id ?? undefined,
        name: c.name,
        creatorName: c.creatorName,
        company: c.company,
        startDate: toDateOrNull(c.startDate),
      },
    });
    return campaignToDomain(row);
  }

  async updateCampaign(
    id: string,
    patch: Partial<Pick<Campaign, "name" | "startDate">>,
  ): Promise<Campaign> {
    const row = await this.prisma.campaign.update({
      where: { id },
      data: {
        name: patch.name,
        startDate: patchDate(patch.startDate),
      },
    });
    return campaignToDomain(row);
  }

  // ── Profiles ───────────────────────────────────────────────────────────────

  async listProfiles(): Promise<PlatformProfile[]> {
    const rows = await this.prisma.platformProfile.findMany();
    return rows.map(profileToDomain);
  }

  async upsertProfileByUrl(
    p: Omit<PlatformProfile, "id"> & { id?: string },
  ): Promise<PlatformProfile> {
    // Matches JsonStore: when the profile URL already exists, return it untouched.
    const row = await this.prisma.platformProfile.upsert({
      where: { profileUrl: p.profileUrl },
      update: {},
      create: {
        id: p.id ?? undefined,
        campaignId: p.campaignId,
        platform: p.platform,
        profileUrl: p.profileUrl,
        handle: p.handle,
        externalProfileId: p.externalProfileId,
        lastDiscoveredAt: toDateOrNull(p.lastDiscoveredAt),
        status: p.status,
      },
    });
    return profileToDomain(row);
  }

  async updateProfile(id: string, patch: Partial<PlatformProfile>): Promise<PlatformProfile> {
    const row = await this.prisma.platformProfile.update({
      where: { id },
      data: {
        campaignId: patch.campaignId,
        platform: patch.platform,
        profileUrl: patch.profileUrl,
        handle: patch.handle,
        externalProfileId: patch.externalProfileId,
        lastDiscoveredAt: patchDate(patch.lastDiscoveredAt),
        status: patch.status,
      },
    });
    return profileToDomain(row);
  }

  // ── Videos ─────────────────────────────────────────────────────────────────

  async listVideos(filter?: VideoFilter): Promise<Video[]> {
    const rows = await this.prisma.video.findMany({
      where: {
        hidden: filter?.includeHidden ? undefined : false,
        platform: filter?.platform,
        episodeGroupId: filter?.episodeGroupId,
      },
      orderBy: { firstTrackedAt: "asc" },
    });
    return rows.map(videoToDomain);
  }

  async getVideo(id: string): Promise<Video | null> {
    const row = await this.prisma.video.findUnique({ where: { id } });
    return row ? videoToDomain(row) : null;
  }

  async findVideoByUrlOrExternalId(
    platform: Platform,
    originalUrl: string | null,
    externalVideoId: string | null,
  ): Promise<Video | null> {
    // Prefer the externalVideoId match, like JsonStore's per-video check order.
    if (externalVideoId) {
      const byExternal = await this.prisma.video.findFirst({
        where: { platform, externalVideoId },
      });
      if (byExternal) return videoToDomain(byExternal);
    }
    if (originalUrl) {
      const byUrl = await this.prisma.video.findFirst({ where: { platform, originalUrl } });
      if (byUrl) return videoToDomain(byUrl);
    }
    return null;
  }

  async insertVideo(v: Omit<Video, "id"> & { id?: string }): Promise<Video> {
    const row = await this.prisma.video.create({
      data: {
        id: v.id ?? undefined,
        campaignId: v.campaignId,
        platform: v.platform,
        profileId: v.profileId,
        originalUrl: v.originalUrl,
        externalVideoId: v.externalVideoId,
        title: v.title,
        caption: v.caption,
        thumbnailUrl: v.thumbnailUrl,
        publishedAt: toDateOrNull(v.publishedAt),
        firstTrackedAt: toDate(v.firstTrackedAt),
        lastRefreshedAt: toDateOrNull(v.lastRefreshedAt),
        status: v.status,
        episodeGroupId: v.episodeGroupId,
        sourceStatus: v.sourceStatus,
        errorMessage: v.errorMessage,
        hidden: v.hidden,
        isSeed: v.isSeed,
        rawJson: toJsonIn(v.rawJson),
      },
    });
    return videoToDomain(row);
  }

  async updateVideo(id: string, patch: Partial<Video>): Promise<Video> {
    const row = await this.prisma.video.update({
      where: { id },
      data: {
        campaignId: patch.campaignId,
        platform: patch.platform,
        profileId: patch.profileId,
        originalUrl: patch.originalUrl,
        externalVideoId: patch.externalVideoId,
        title: patch.title,
        caption: patch.caption,
        thumbnailUrl: patch.thumbnailUrl,
        publishedAt: patchDate(patch.publishedAt),
        firstTrackedAt: patch.firstTrackedAt === undefined ? undefined : toDate(patch.firstTrackedAt),
        lastRefreshedAt: patchDate(patch.lastRefreshedAt),
        status: patch.status,
        episodeGroupId: patch.episodeGroupId,
        sourceStatus: patch.sourceStatus,
        errorMessage: patch.errorMessage,
        hidden: patch.hidden,
        isSeed: patch.isSeed,
        rawJson: patchJson(patch.rawJson),
      },
    });
    return videoToDomain(row);
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  async addSnapshot(s: Omit<MetricSnapshot, "id"> & { id?: string }): Promise<MetricSnapshot> {
    const row = await this.prisma.metricSnapshot.create({
      data: {
        id: s.id ?? undefined,
        videoId: s.videoId,
        capturedAt: toDate(s.capturedAt),
        views: s.views,
        likes: s.likes,
        comments: s.comments,
        shares: s.shares,
        saves: s.saves,
        bookmarks: s.bookmarks,
        engagementRate: s.engagementRate,
        rawJson: toJsonIn(s.rawJson),
      },
    });
    return snapshotToDomain(row);
  }

  async listSnapshots(videoId: string, sinceIso?: string): Promise<MetricSnapshot[]> {
    const rows = await this.prisma.metricSnapshot.findMany({
      where: {
        videoId,
        capturedAt: sinceIso ? { gte: new Date(sinceIso) } : undefined,
      },
      orderBy: { capturedAt: "asc" },
    });
    return rows.map(snapshotToDomain);
  }

  async listAllSnapshots(sinceIso?: string): Promise<MetricSnapshot[]> {
    const rows = await this.prisma.metricSnapshot.findMany({
      where: { capturedAt: sinceIso ? { gte: new Date(sinceIso) } : undefined },
      orderBy: { capturedAt: "asc" },
    });
    return rows.map(snapshotToDomain);
  }

  // ── Comments ───────────────────────────────────────────────────────────────

  async upsertComment(
    c: Omit<Comment, "id"> & { id?: string },
  ): Promise<{ comment: Comment; created: boolean }> {
    // JsonStore semantics: only overwrite likes/replyCount when the new value
    // is non-null (counts move over time; null means "platform didn't say").
    // Derived fields (tags/sentiment/needsResponse) always refresh so tagging
    // rule changes propagate on re-ingestion.
    const refresh = {
      likes: c.likes ?? undefined,
      replyCount: c.replyCount ?? undefined,
      tags: c.tags,
      sentiment: c.sentiment,
      needsResponse: c.needsResponse,
    };
    const createData: Prisma.CommentUncheckedCreateInput = {
      id: c.id ?? undefined,
      videoId: c.videoId,
      platform: c.platform,
      externalCommentId: c.externalCommentId,
      authorName: c.authorName,
      text: c.text,
      postedAt: toDateOrNull(c.postedAt),
      likes: c.likes,
      replyCount: c.replyCount,
      sentiment: c.sentiment,
      needsResponse: c.needsResponse,
      tags: c.tags,
      permalink: c.permalink,
      capturedAt: toDate(c.capturedAt),
      rawJson: toJsonIn(c.rawJson),
    };

    if (c.externalCommentId) {
      // Dedupe by (videoId, externalCommentId) — backed by a unique constraint.
      const key = { videoId: c.videoId, externalCommentId: c.externalCommentId };
      const existing = await this.prisma.comment.findUnique({
        where: { videoId_externalCommentId: key },
      });
      if (existing) {
        const row = await this.prisma.comment.update({
          where: { videoId_externalCommentId: key },
          data: refresh,
        });
        return { comment: commentToDomain(row), created: false };
      }
      try {
        const row = await this.prisma.comment.create({ data: createData });
        return { comment: commentToDomain(row), created: true };
      } catch (err) {
        // Lost a concurrent-insert race: the unique constraint fired, so the
        // row exists now — update it like the found-existing branch.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          const row = await this.prisma.comment.update({
            where: { videoId_externalCommentId: key },
            data: refresh,
          });
          return { comment: commentToDomain(row), created: false };
        }
        throw err;
      }
    }

    // No external id — fall back to (videoId, text, authorName) like JsonStore.
    const existing = await this.prisma.comment.findFirst({
      where: { videoId: c.videoId, text: c.text, authorName: c.authorName },
    });
    if (existing) {
      const row = await this.prisma.comment.update({ where: { id: existing.id }, data: refresh });
      return { comment: commentToDomain(row), created: false };
    }
    const row = await this.prisma.comment.create({ data: createData });
    return { comment: commentToDomain(row), created: true };
  }

  async listComments(filter?: CommentFilter): Promise<Comment[]> {
    const rows = await this.prisma.comment.findMany({
      where: {
        platform: filter?.platform,
        videoId: filter?.videoId,
      },
      orderBy: { capturedAt: "desc" },
    });
    // Match JsonStore: sort by postedAt ?? capturedAt desc (Prisma can't
    // coalesce-order), then apply the limit AFTER the re-sort.
    let out = rows.map(commentToDomain);
    out = out.sort((a, b) =>
      (b.postedAt ?? b.capturedAt).localeCompare(a.postedAt ?? a.capturedAt),
    );
    if (filter?.limit) out = out.slice(0, filter.limit);
    return out;
  }

  // ── Refresh runs ───────────────────────────────────────────────────────────

  async createRefreshRun(r: Omit<RefreshRun, "id"> & { id?: string }): Promise<RefreshRun> {
    const row = await this.prisma.refreshRun.create({
      data: {
        id: r.id ?? undefined,
        startedAt: toDate(r.startedAt),
        finishedAt: toDateOrNull(r.finishedAt),
        status: r.status,
        trigger: r.trigger,
        platformsAttempted: r.platformsAttempted,
        videosUpdated: r.videosUpdated,
        commentsUpdated: r.commentsUpdated,
        newVideosDiscovered: r.newVideosDiscovered,
        errors: r.errors,
        rawLog: r.rawLog ?? [],
      },
    });
    return refreshRunToDomain(row);
  }

  async updateRefreshRun(id: string, patch: Partial<RefreshRun>): Promise<RefreshRun> {
    const row = await this.prisma.refreshRun.update({
      where: { id },
      data: {
        startedAt: patch.startedAt === undefined ? undefined : toDate(patch.startedAt),
        finishedAt: patchDate(patch.finishedAt),
        status: patch.status,
        trigger: patch.trigger,
        platformsAttempted: patch.platformsAttempted,
        videosUpdated: patch.videosUpdated,
        commentsUpdated: patch.commentsUpdated,
        newVideosDiscovered: patch.newVideosDiscovered,
        errors: patch.errors,
        rawLog: patch.rawLog === undefined ? undefined : patch.rawLog ?? [],
      },
    });
    return refreshRunToDomain(row);
  }

  async listRefreshRuns(limit = 20): Promise<RefreshRun[]> {
    const rows = await this.prisma.refreshRun.findMany({
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return rows.map(refreshRunToDomain);
  }

  // ── Episode groups ─────────────────────────────────────────────────────────

  async listEpisodeGroups(): Promise<EpisodeGroup[]> {
    const rows = await this.prisma.episodeGroup.findMany({ orderBy: { createdAt: "asc" } });
    return rows.map(episodeGroupToDomain);
  }

  async upsertEpisodeGroupByName(
    e: Omit<EpisodeGroup, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<EpisodeGroup> {
    // Matches JsonStore: existing groups are returned untouched.
    const row = await this.prisma.episodeGroup.upsert({
      where: { campaignId_name: { campaignId: e.campaignId, name: e.name } },
      update: {},
      create: {
        id: e.id ?? undefined,
        campaignId: e.campaignId,
        name: e.name,
        description: e.description,
      },
    });
    return episodeGroupToDomain(row);
  }

  // ── Alerts ─────────────────────────────────────────────────────────────────

  async listAlerts(status?: AlertStatus): Promise<Alert[]> {
    const rows = await this.prisma.alert.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
    });
    return rows.map(alertToDomain);
  }

  async findOpenAlertByDedupeKey(key: string): Promise<Alert | null> {
    const row = await this.prisma.alert.findFirst({
      where: { dedupeKey: key, status: "open" },
    });
    return row ? alertToDomain(row) : null;
  }

  async createAlert(a: Omit<Alert, "id"> & { id?: string }): Promise<Alert> {
    const row = await this.prisma.alert.create({
      data: {
        id: a.id ?? undefined,
        campaignId: a.campaignId,
        videoId: a.videoId,
        platform: a.platform,
        type: a.type,
        severity: a.severity,
        title: a.title,
        message: a.message,
        suggestedAction: a.suggestedAction,
        createdAt: toDate(a.createdAt),
        reviewedAt: toDateOrNull(a.reviewedAt),
        status: a.status,
        dedupeKey: a.dedupeKey,
      },
    });
    return alertToDomain(row);
  }

  async reviewAlert(id: string): Promise<Alert> {
    const row = await this.prisma.alert.update({
      where: { id },
      data: { status: "reviewed", reviewedAt: new Date() },
    });
    return alertToDomain(row);
  }

  // ── Overrides ──────────────────────────────────────────────────────────────

  async addOverride(
    o: Omit<ManualOverride, "id" | "createdAt"> & { id?: string },
  ): Promise<ManualOverride> {
    const row = await this.prisma.manualOverride.create({
      data: {
        id: o.id ?? undefined,
        entityType: o.entityType,
        entityId: o.entityId,
        field: o.field,
        oldValue: o.oldValue,
        newValue: o.newValue,
        reason: o.reason,
      },
    });
    return overrideToDomain(row);
  }

  async listOverrides(limit = 50): Promise<ManualOverride[]> {
    const rows = await this.prisma.manualOverride.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map(overrideToDomain);
  }

  // ── Provider configs ───────────────────────────────────────────────────────

  async listProviderConfigs(): Promise<ProviderConfig[]> {
    const rows = await this.prisma.providerConfig.findMany();
    return rows.map(providerConfigToDomain);
  }

  async getProviderConfig(platform: Platform): Promise<ProviderConfig | null> {
    const row = await this.prisma.providerConfig.findUnique({ where: { platform } });
    return row ? providerConfigToDomain(row) : null;
  }

  async upsertProviderConfig(
    p: Omit<ProviderConfig, "id" | "updatedAt"> & { id?: string },
  ): Promise<ProviderConfig> {
    // JsonStore replaces every field on the existing config; mirror that here.
    const data = {
      providerType: p.providerType,
      actorId: p.actorId,
      status: p.status,
      lastTestedAt: toDateOrNull(p.lastTestedAt),
      lastTestResult: toJsonIn(p.lastTestResult),
      detectedFields: p.detectedFields,
      supportsMetadata: p.supportsMetadata,
      supportsMetrics: p.supportsMetrics,
      supportsComments: p.supportsComments,
      supportsDiscovery: p.supportsDiscovery,
      inputOverride: toJsonIn(p.inputOverride),
      lastSuccessfulRefreshAt: toDateOrNull(p.lastSuccessfulRefreshAt),
    };
    const row = await this.prisma.providerConfig.upsert({
      where: { platform: p.platform },
      update: data,
      create: { id: p.id ?? undefined, platform: p.platform, ...data },
    });
    return providerConfigToDomain(row);
  }
}
