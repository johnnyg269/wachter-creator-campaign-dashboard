// One-off benchmark: official YouTube Data API vs the stored Apify YouTube
// Shorts data, for the campaign's known tracked Shorts. Uses STORED Apify
// rawJson (no Apify credits burned) and a single live YouTube API call
// (videos.list — 1 quota unit). Writes docs/youtube-api-benchmark.md.
//
//   npm_config_cache=/tmp npx tsx scripts/youtube-benchmark.ts
//
// Never prints the API key.

import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { loadEnvLocal } from "./load-env";

loadEnvLocal();

interface StoredVideo {
  platform: string;
  externalVideoId: string | null;
  originalUrl: string;
  rawJson: Record<string, unknown> | null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  const keyPresent = Boolean(key);

  const dbPath = path.join(process.cwd(), "data", "local-db.json");
  const db = JSON.parse(readFileSync(dbPath, "utf-8")) as { videos: StoredVideo[] };
  const yt = db.videos.filter((v) => v.platform === "youtube" && v.externalVideoId);
  const ids = yt.map((v) => v.externalVideoId!) as string[];

  console.log(`YouTube benchmark — ${ids.length} tracked Short(s): ${ids.join(", ")}`);
  console.log(`YOUTUBE_API_KEY present: ${keyPresent ? "yes (configured)" : "NO"}`);

  // ── Live YouTube API call (single videos.list) ──────────────────────────
  let apiItems: Array<Record<string, unknown>> = [];
  let apiError: string | null = null;
  if (keyPresent) {
    const qs = new URLSearchParams({ part: "snippet,statistics", id: ids.join(","), key: key! });
    try {
      const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${qs}`, { cache: "no-store" });
      if (!res.ok) {
        const body = await res.text();
        apiError = `HTTP ${res.status}: ${body.slice(0, 200).replaceAll(key!, "[REDACTED]")}`;
      } else {
        const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
        apiItems = data.items ?? [];
      }
    } catch (e) {
      apiError = e instanceof Error ? e.message.replaceAll(key!, "[REDACTED]") : String(e);
    }
  }
  if (apiError) console.log(`API error: ${apiError}`);

  const apiById = new Map<string, Record<string, unknown>>();
  for (const it of apiItems) apiById.set(String(it.id), it);

  // ── Field-by-field comparison ───────────────────────────────────────────
  const fields = ["title", "thumbnail", "publishedAt", "views", "likes", "comments", "channel"] as const;
  const rows: Array<Record<string, string>> = [];
  let apiComplete = true;

  for (const v of yt) {
    const id = v.externalVideoId!;
    const apify = v.rawJson ?? {};
    const api = apiById.get(id);
    const sn = (api?.snippet ?? {}) as Record<string, unknown>;
    const st = (api?.statistics ?? {}) as Record<string, unknown>;
    const thumbs = (sn.thumbnails ?? {}) as Record<string, { url?: string }>;
    const apiThumb = thumbs.maxres?.url ?? thumbs.high?.url ?? thumbs.medium?.url ?? thumbs.default?.url ?? null;

    const apiVals: Record<string, unknown> = {
      title: sn.title ?? null,
      thumbnail: apiThumb,
      publishedAt: sn.publishedAt ?? null,
      views: num(st.viewCount),
      likes: num(st.likeCount),
      comments: num(st.commentCount),
      channel: sn.channelTitle ?? null,
    };
    const apifyVals: Record<string, unknown> = {
      title: apify.title ?? null,
      thumbnail: apify.thumbnailUrl ?? null,
      publishedAt: apify.date ?? null,
      views: num(apify.viewCount),
      likes: num(apify.likes),
      comments: num(apify.commentsCount),
      channel: apify.channelName ?? null,
    };

    for (const f of fields) {
      const present = apiVals[f] !== null && apiVals[f] !== undefined;
      if (!present) apiComplete = false;
      rows.push({
        id,
        field: f,
        api: present ? String(apiVals[f]).slice(0, 40) : "— MISSING",
        apify: apifyVals[f] !== null && apifyVals[f] !== undefined ? String(apifyVals[f]).slice(0, 40) : "—",
      });
    }
  }

  // ── Print table ─────────────────────────────────────────────────────────
  console.log("\n  video        field        YouTube API                 Apify (stored)");
  console.log("  " + "-".repeat(86));
  for (const r of rows) {
    console.log(
      `  ${r.id.padEnd(12)} ${r.field.padEnd(12)} ${r.api.padEnd(28)} ${r.apify}`,
    );
  }

  const missing = rows.filter((r) => r.api === "— MISSING").map((r) => `${r.id}:${r.field}`);
  console.log(
    `\nVerdict: YouTube API ${apiComplete ? "returned ALL required fields" : "is MISSING fields → " + missing.join(", ")}`,
  );
  console.log("Note: YouTube API does not expose share counts (shares=null) — same as Apify shorts scraper.");

  // ── Write markdown report ───────────────────────────────────────────────
  const md = [
    "# YouTube Data API vs Apify — benchmark",
    "",
    `Generated by \`scripts/youtube-benchmark.ts\`. Compares the official YouTube Data API (\`videos.list\`, part=snippet,statistics) against the **stored** Apify \`streamers/youtube-shorts-scraper\` rawJson for the campaign's tracked Shorts. No Apify credits were spent (stored data reused); one YouTube API call (1 quota unit).`,
    "",
    `- Tracked Shorts: ${ids.map((i) => "`" + i + "`").join(", ")}`,
    `- \`YOUTUBE_API_KEY\` present: **${keyPresent ? "yes" : "no"}**`,
    apiError ? `- API error: \`${apiError}\`` : `- API call: OK (${apiItems.length} item(s) returned)`,
    "",
    "| Video | Field | YouTube API | Apify (stored) |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.id} | ${r.field} | ${r.api} | ${r.apify} |`),
    "",
    "## Verdict",
    "",
    apiComplete
      ? "The YouTube Data API returns **all required fields** (title, thumbnail, publishedAt, views, likes, comments, channel) for every tracked Short. Shares are unavailable from both sources (YouTube has no public share count)."
      : `The YouTube Data API is **missing**: ${missing.join(", ")}.`,
    "",
    "## Decision",
    "",
    "- The app already routes YouTube to the official API when `YOUTUBE_API_KEY` is set (see `src/lib/providers/registry.ts`); the Apify YouTube scraper is **fallback-only** (used when no key).",
    "- Cost impact: YouTube metrics now cost **0 Apify runs** on normal refreshes (YouTube Data API quota is free, 10,000 units/day; videos.list = 1 unit/refresh).",
    "- Last-known-good, monotonic-views, and thumbnail protections live in the refresh pipeline and apply identically to API-sourced data.",
  ].join("\n");
  const out = path.join(process.cwd(), "docs", "youtube-api-benchmark.md");
  writeFileSync(out, md + "\n");
  console.log(`\nWrote ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
