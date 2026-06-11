// Thin Apify REST client. Server-side only. The token is read from env at
// call time, sent only as an Authorization header, and scrubbed from any
// error text — it must never reach logs or the client bundle.

import { getApifyToken } from "../config";

const BASE = "https://api.apify.com/v2";

export type ApifyErrorCode =
  | "token_missing"
  | "token_invalid"
  | "actor_not_found"
  | "run_failed"
  | "run_timeout"
  | "bad_input"
  | "network";

export class ApifyError extends Error {
  code: ApifyErrorCode;
  constructor(code: ApifyErrorCode, message: string) {
    super(scrubToken(message));
    this.code = code;
    this.name = "ApifyError";
  }
}

function scrubToken(text: string): string {
  const token = getApifyToken();
  let out = text;
  if (token) out = out.split(token).join("[REDACTED]");
  return out.replace(/apify_api_\w+/g, "[REDACTED]");
}

async function apifyFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getApifyToken();
  if (!token) throw new ApifyError("token_missing", "APIFY_TOKEN is not configured");
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  }).catch((e: unknown) => {
    throw new ApifyError("network", `Apify request failed: ${String(e)}`);
  });
  if (res.status === 401) throw new ApifyError("token_invalid", "Apify rejected the token (401)");
  return res;
}

export interface ApifyTokenStatus {
  configured: boolean;
  valid: boolean | null;
  username: string | null;
  error: string | null;
}

/** Validates the token by fetching the account (never returns the token). */
export async function checkToken(): Promise<ApifyTokenStatus> {
  if (!getApifyToken()) {
    return { configured: false, valid: null, username: null, error: null };
  }
  try {
    const res = await apifyFetch("/users/me");
    if (!res.ok) {
      return { configured: true, valid: false, username: null, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { data?: { username?: string } };
    return { configured: true, valid: true, username: data.data?.username ?? null, error: null };
  } catch (e) {
    const msg = e instanceof ApifyError ? e.message : String(e);
    return { configured: true, valid: false, username: null, error: scrubToken(msg) };
  }
}

export interface ActorInfo {
  id: string;
  name: string;
  username: string;
  title: string | null;
  description: string | null;
  isPublic: boolean;
  totalRuns: number | null;
}

export async function getActorInfo(actorId: string): Promise<ActorInfo> {
  const res = await apifyFetch(`/acts/${encodeURIComponent(actorId)}`);
  if (res.status === 404) {
    throw new ApifyError("actor_not_found", `Actor "${actorId}" not found or not accessible`);
  }
  if (!res.ok) throw new ApifyError("network", `Actor lookup failed (HTTP ${res.status})`);
  const { data } = (await res.json()) as { data: Record<string, unknown> };
  const stats = (data.stats ?? {}) as Record<string, unknown>;
  return {
    id: String(data.id ?? actorId),
    name: String(data.name ?? ""),
    username: String(data.username ?? ""),
    title: (data.title as string) ?? null,
    description: (data.description as string) ?? null,
    isPublic: Boolean(data.isPublic),
    totalRuns: typeof stats.totalRuns === "number" ? stats.totalRuns : null,
  };
}

export interface RunActorResult {
  runId: string;
  status: string;
  items: Array<Record<string, unknown>>;
  durationMs: number;
  datasetId: string | null;
  statusMessage: string | null;
}

interface RunRecord {
  id: string;
  status: string;
  defaultDatasetId?: string;
  statusMessage?: string;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

/**
 * Run an actor and wait for completion (long-poll + bounded polling — no
 * hammering). Returns dataset items on success; throws ApifyError on failure.
 */
export async function runActor(opts: {
  actorId: string;
  input: unknown;
  /** Hard wall-clock budget for the whole run. */
  timeoutMs?: number;
  maxItems?: number;
}): Promise<RunActorResult> {
  const { actorId, input, timeoutMs = 240_000, maxItems = 200 } = opts;
  const started = Date.now();

  const startRes = await apifyFetch(
    `/acts/${encodeURIComponent(actorId)}/runs?waitForFinish=55`,
    { method: "POST", body: JSON.stringify(input ?? {}) },
  );
  if (startRes.status === 404) {
    throw new ApifyError("actor_not_found", `Actor "${actorId}" not found or not accessible`);
  }
  if (startRes.status === 400) {
    const body = await startRes.text();
    throw new ApifyError("bad_input", `Actor rejected input: ${body.slice(0, 300)}`);
  }
  if (!startRes.ok) {
    throw new ApifyError("run_failed", `Failed to start actor run (HTTP ${startRes.status})`);
  }
  let run = ((await startRes.json()) as { data: RunRecord }).data;

  while (!TERMINAL.has(run.status)) {
    if (Date.now() - started > timeoutMs) {
      // Abort so we don't keep burning credits on a stuck run.
      await apifyFetch(`/actor-runs/${run.id}/abort`, { method: "POST" }).catch(() => undefined);
      throw new ApifyError("run_timeout", `Actor run exceeded ${Math.round(timeoutMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await apifyFetch(`/actor-runs/${run.id}`);
    if (!poll.ok) throw new ApifyError("network", `Run poll failed (HTTP ${poll.status})`);
    run = ((await poll.json()) as { data: RunRecord }).data;
  }

  if (run.status !== "SUCCEEDED") {
    throw new ApifyError(
      "run_failed",
      `Actor run ${run.status}${run.statusMessage ? `: ${run.statusMessage}` : ""}`,
    );
  }

  let items: Array<Record<string, unknown>> = [];
  if (run.defaultDatasetId) {
    const itemsRes = await apifyFetch(
      `/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=${maxItems}`,
    );
    if (itemsRes.ok) {
      items = (await itemsRes.json()) as Array<Record<string, unknown>>;
    }
  }

  return {
    runId: run.id,
    status: run.status,
    items,
    durationMs: Date.now() - started,
    datasetId: run.defaultDatasetId ?? null,
    statusMessage: run.statusMessage ?? null,
  };
}

export interface StoreActorCandidate {
  actorId: string;
  name: string;
  username: string;
  title: string | null;
  description: string | null;
  totalRuns: number | null;
}

/** Search the public Apify Store (used by the admin "find an actor" helper). */
export async function searchApifyStore(query: string): Promise<StoreActorCandidate[]> {
  const res = await apifyFetch(`/store?search=${encodeURIComponent(query)}&limit=10`);
  if (!res.ok) throw new ApifyError("network", `Store search failed (HTTP ${res.status})`);
  const { data } = (await res.json()) as {
    data: { items: Array<Record<string, unknown>> };
  };
  return (data.items ?? []).map((it) => {
    const stats = (it.stats ?? {}) as Record<string, unknown>;
    return {
      actorId: String(it.id ?? ""),
      name: String(it.name ?? ""),
      username: String(it.username ?? ""),
      title: (it.title as string) ?? null,
      description: ((it.description as string) ?? "").slice(0, 200) || null,
      totalRuns: typeof stats.totalRuns === "number" ? stats.totalRuns : null,
    };
  });
}
