// Local JSON file store. Default when DATABASE_URL is not set.
// Durable on a developer machine (./data/local-db.json); on Vercel it can only
// write to /tmp, which is wiped between invocations — info().ephemeral flags
// that so the UI can warn instead of silently losing data.

import { promises as fs } from "fs";
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
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
import type { CommentFilter, Store, StoreInfo, VideoFilter } from "./types";

interface DbShape {
  campaigns: Campaign[];
  profiles: PlatformProfile[];
  videos: Video[];
  snapshots: MetricSnapshot[];
  comments: Comment[];
  refreshRuns: RefreshRun[];
  episodeGroups: EpisodeGroup[];
  alerts: Alert[];
  overrides: ManualOverride[];
  providerConfigs: ProviderConfig[];
}

const EMPTY: DbShape = {
  campaigns: [],
  profiles: [],
  videos: [],
  snapshots: [],
  comments: [],
  refreshRuns: [],
  episodeGroups: [],
  alerts: [],
  overrides: [],
  providerConfigs: [],
};

function resolveDbPath(): { file: string; ephemeral: boolean } {
  if (process.env.VERCEL) {
    return { file: "/tmp/wachter-campaign-db.json", ephemeral: true };
  }
  const dir = path.join(process.cwd(), "data");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return { file: path.join(dir, "local-db.json"), ephemeral: false };
  } catch {
    return { file: "/tmp/wachter-campaign-db.json", ephemeral: true };
  }
}

export class JsonStore implements Store {
  private file: string;
  private ephemeral: boolean;
  private db: DbShape | null = null;
  /** mtime of the file when we last loaded it — lets us detect writes from
   * other processes (e.g. `npm run refresh`) and re-read instead of serving
   * a stale in-memory copy forever. */
  private loadedMtimeMs: number | null = null;
  /** Serializes writes so concurrent route handlers don't clobber the file. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    const { file, ephemeral } = resolveDbPath();
    this.file = file;
    this.ephemeral = ephemeral;
  }

  info(): StoreInfo {
    return {
      kind: "json",
      ephemeral: this.ephemeral,
      detail: this.ephemeral
        ? "JSON store on ephemeral /tmp — set DATABASE_URL for durable storage"
        : `Local JSON file (${path.relative(process.cwd(), this.file)})`,
    };
  }

  private async load(): Promise<DbShape> {
    let mtimeMs: number | null = null;
    try {
      mtimeMs = (await fs.stat(this.file)).mtimeMs;
    } catch {
      // file doesn't exist yet
    }
    if (this.db && mtimeMs !== null && this.loadedMtimeMs !== null && mtimeMs === this.loadedMtimeMs) {
      return this.db;
    }
    if (this.db && mtimeMs === null) return this.db;
    try {
      const raw = await fs.readFile(this.file, "utf-8");
      this.db = { ...EMPTY, ...(JSON.parse(raw) as Partial<DbShape>) };
      this.loadedMtimeMs = mtimeMs;
    } catch {
      this.db = this.db ?? structuredClone(EMPTY);
    }
    return this.db;
  }

  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.db) return;
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.db, null, 1), "utf-8");
      await fs.rename(tmp, this.file);
      this.loadedMtimeMs = (await fs.stat(this.file)).mtimeMs;
    });
    return this.writeQueue;
  }

  // ── Campaign ──────────────────────────────────────────────────────────────

  async getCampaign(): Promise<Campaign | null> {
    const db = await this.load();
    return db.campaigns[0] ?? null;
  }

  async upsertCampaign(
    c: Omit<Campaign, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<Campaign> {
    const db = await this.load();
    const existing = db.campaigns.find((x) => x.name === c.name);
    const now = new Date().toISOString();
    if (existing) {
      // No-op upserts (every page load seeds) must not touch the file —
      // gratuitous writes can clobber concurrent writers.
      if (existing.creatorName !== c.creatorName || existing.company !== c.company) {
        Object.assign(existing, { creatorName: c.creatorName, company: c.company, updatedAt: now });
        await this.persist();
      }
      return existing;
    }
    const created: Campaign = { id: c.id ?? randomUUID(), createdAt: now, updatedAt: now, ...c };
    db.campaigns.push(created);
    await this.persist();
    return created;
  }

  async updateCampaign(
    id: string,
    patch: Partial<Pick<Campaign, "name" | "startDate">>,
  ): Promise<Campaign> {
    const db = await this.load();
    const c = db.campaigns.find((x) => x.id === id);
    if (!c) throw new Error(`Campaign ${id} not found`);
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return c;
  }

  // ── Profiles ──────────────────────────────────────────────────────────────

  async listProfiles(): Promise<PlatformProfile[]> {
    return (await this.load()).profiles;
  }

  async upsertProfileByUrl(
    p: Omit<PlatformProfile, "id"> & { id?: string },
  ): Promise<PlatformProfile> {
    const db = await this.load();
    const existing = db.profiles.find((x) => x.profileUrl === p.profileUrl);
    if (existing) return existing;
    const created: PlatformProfile = { id: p.id ?? randomUUID(), ...p };
    db.profiles.push(created);
    await this.persist();
    return created;
  }

  async updateProfile(id: string, patch: Partial<PlatformProfile>): Promise<PlatformProfile> {
    const db = await this.load();
    const p = db.profiles.find((x) => x.id === id);
    if (!p) throw new Error(`Profile ${id} not found`);
    Object.assign(p, patch);
    await this.persist();
    return p;
  }

  // ── Videos ────────────────────────────────────────────────────────────────

  async listVideos(filter?: VideoFilter): Promise<Video[]> {
    const db = await this.load();
    return db.videos.filter((v) => {
      if (!filter?.includeHidden && v.hidden) return false;
      if (filter?.platform && v.platform !== filter.platform) return false;
      if (filter?.episodeGroupId && v.episodeGroupId !== filter.episodeGroupId) return false;
      return true;
    });
  }

  async getVideo(id: string): Promise<Video | null> {
    const db = await this.load();
    return db.videos.find((v) => v.id === id) ?? null;
  }

  async findVideoByUrlOrExternalId(
    platform: Platform,
    originalUrl: string | null,
    externalVideoId: string | null,
  ): Promise<Video | null> {
    const db = await this.load();
    return (
      db.videos.find((v) => {
        if (v.platform !== platform) return false;
        if (externalVideoId && v.externalVideoId === externalVideoId) return true;
        if (originalUrl && v.originalUrl === originalUrl) return true;
        return false;
      }) ?? null
    );
  }

  async insertVideo(v: Omit<Video, "id"> & { id?: string }): Promise<Video> {
    const db = await this.load();
    const created: Video = { id: v.id ?? randomUUID(), ...v };
    db.videos.push(created);
    await this.persist();
    return created;
  }

  async updateVideo(id: string, patch: Partial<Video>): Promise<Video> {
    const db = await this.load();
    const v = db.videos.find((x) => x.id === id);
    if (!v) throw new Error(`Video ${id} not found`);
    Object.assign(v, patch);
    await this.persist();
    return v;
  }

  // ── Snapshots ─────────────────────────────────────────────────────────────

  async addSnapshot(s: Omit<MetricSnapshot, "id"> & { id?: string }): Promise<MetricSnapshot> {
    const db = await this.load();
    const created: MetricSnapshot = { id: s.id ?? randomUUID(), ...s };
    db.snapshots.push(created);
    await this.persist();
    return created;
  }

  async listSnapshots(videoId: string, sinceIso?: string): Promise<MetricSnapshot[]> {
    const db = await this.load();
    return db.snapshots.filter(
      (s) => s.videoId === videoId && (!sinceIso || s.capturedAt >= sinceIso),
    );
  }

  async listAllSnapshots(sinceIso?: string): Promise<MetricSnapshot[]> {
    const db = await this.load();
    return sinceIso ? db.snapshots.filter((s) => s.capturedAt >= sinceIso) : db.snapshots;
  }

  // ── Comments ──────────────────────────────────────────────────────────────

  async upsertComment(
    c: Omit<Comment, "id"> & { id?: string },
  ): Promise<{ comment: Comment; created: boolean }> {
    const db = await this.load();
    const existing = db.comments.find((x) => {
      if (x.videoId !== c.videoId) return false;
      if (c.externalCommentId && x.externalCommentId === c.externalCommentId) return true;
      if (!c.externalCommentId && x.text === c.text && x.authorName === c.authorName) return true;
      return false;
    });
    if (existing) {
      // Refresh mutable + derived fields (like counts move over time; tag and
      // sentiment rules evolve and should propagate on re-ingestion).
      existing.likes = c.likes ?? existing.likes;
      existing.replyCount = c.replyCount ?? existing.replyCount;
      existing.tags = c.tags;
      existing.sentiment = c.sentiment;
      existing.needsResponse = c.needsResponse;
      await this.persist();
      return { comment: existing, created: false };
    }
    const created: Comment = { id: c.id ?? randomUUID(), ...c };
    db.comments.push(created);
    await this.persist();
    return { comment: created, created: true };
  }

  async listComments(filter?: CommentFilter): Promise<Comment[]> {
    const db = await this.load();
    let out = db.comments.filter((c) => {
      if (filter?.platform && c.platform !== filter.platform) return false;
      if (filter?.videoId && c.videoId !== filter.videoId) return false;
      return true;
    });
    out = out.sort((a, b) =>
      (b.postedAt ?? b.capturedAt).localeCompare(a.postedAt ?? a.capturedAt),
    );
    if (filter?.limit) out = out.slice(0, filter.limit);
    return out;
  }

  // ── Refresh runs ──────────────────────────────────────────────────────────

  async createRefreshRun(r: Omit<RefreshRun, "id"> & { id?: string }): Promise<RefreshRun> {
    const db = await this.load();
    const created: RefreshRun = { id: r.id ?? randomUUID(), ...r };
    db.refreshRuns.push(created);
    await this.persist();
    return created;
  }

  async updateRefreshRun(id: string, patch: Partial<RefreshRun>): Promise<RefreshRun> {
    const db = await this.load();
    const r = db.refreshRuns.find((x) => x.id === id);
    if (!r) throw new Error(`RefreshRun ${id} not found`);
    Object.assign(r, patch);
    await this.persist();
    return r;
  }

  async listRefreshRuns(limit = 20): Promise<RefreshRun[]> {
    const db = await this.load();
    return [...db.refreshRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  // ── Episode groups ────────────────────────────────────────────────────────

  async listEpisodeGroups(): Promise<EpisodeGroup[]> {
    return (await this.load()).episodeGroups;
  }

  async upsertEpisodeGroupByName(
    e: Omit<EpisodeGroup, "id" | "createdAt" | "updatedAt"> & { id?: string },
  ): Promise<EpisodeGroup> {
    const db = await this.load();
    const existing = db.episodeGroups.find((x) => x.name === e.name);
    if (existing) return existing;
    const now = new Date().toISOString();
    const created: EpisodeGroup = { id: e.id ?? randomUUID(), createdAt: now, updatedAt: now, ...e };
    db.episodeGroups.push(created);
    await this.persist();
    return created;
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  async listAlerts(status?: AlertStatus): Promise<Alert[]> {
    const db = await this.load();
    const out = status ? db.alerts.filter((a) => a.status === status) : db.alerts;
    return [...out].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findOpenAlertByDedupeKey(key: string): Promise<Alert | null> {
    const db = await this.load();
    return db.alerts.find((a) => a.dedupeKey === key && a.status === "open") ?? null;
  }

  async createAlert(a: Omit<Alert, "id"> & { id?: string }): Promise<Alert> {
    const db = await this.load();
    const created: Alert = { id: a.id ?? randomUUID(), ...a };
    db.alerts.push(created);
    await this.persist();
    return created;
  }

  async reviewAlert(id: string): Promise<Alert> {
    const db = await this.load();
    const a = db.alerts.find((x) => x.id === id);
    if (!a) throw new Error(`Alert ${id} not found`);
    a.status = "reviewed";
    a.reviewedAt = new Date().toISOString();
    await this.persist();
    return a;
  }

  // ── Overrides ─────────────────────────────────────────────────────────────

  async addOverride(
    o: Omit<ManualOverride, "id" | "createdAt"> & { id?: string },
  ): Promise<ManualOverride> {
    const db = await this.load();
    const created: ManualOverride = {
      id: o.id ?? randomUUID(),
      createdAt: new Date().toISOString(),
      ...o,
    };
    db.overrides.push(created);
    await this.persist();
    return created;
  }

  async listOverrides(limit = 50): Promise<ManualOverride[]> {
    const db = await this.load();
    return [...db.overrides].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  // ── Provider configs ──────────────────────────────────────────────────────

  async listProviderConfigs(): Promise<ProviderConfig[]> {
    return (await this.load()).providerConfigs;
  }

  async getProviderConfig(platform: Platform): Promise<ProviderConfig | null> {
    const db = await this.load();
    return db.providerConfigs.find((p) => p.platform === platform) ?? null;
  }

  async upsertProviderConfig(
    p: Omit<ProviderConfig, "id" | "updatedAt"> & { id?: string },
  ): Promise<ProviderConfig> {
    const db = await this.load();
    const existing = db.providerConfigs.find((x) => x.platform === p.platform);
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, p, { id: existing.id, updatedAt: now });
      await this.persist();
      return existing;
    }
    const created: ProviderConfig = { id: p.id ?? randomUUID(), updatedAt: now, ...p };
    db.providerConfigs.push(created);
    await this.persist();
    return created;
  }
}
