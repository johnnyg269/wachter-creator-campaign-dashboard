// SocialCrawl shadow / benchmark refresh — NON-DESTRUCTIVE.
//
// Pulls TikTok + Instagram + Facebook metrics from SocialCrawl ONLY (YouTube is
// intentionally excluded — it stays on the official YouTube Data API), normalizes
// them into the app's NormalizedVideo shape, and prints a shadow report. It does
// NOT call Apify, does NOT write to the database, and does NOT change provider
// routing. It is a comparison/benchmark tool, not a production switch.
//
//   npm_config_cache=/tmp npx tsx scripts/socialcrawl-shadow-refresh.ts
//
// Requires SOCIALCRAWL_API_KEY in .env.local (untracked). The key is read from
// env and is NEVER printed (redacted in any output). Default mode is dry-run.
//
// Why profile endpoints (not Prism post-stats): the Prism /prism/post-stats
// batch endpoint returns status:"unsupported" for these post URLs. The
// per-platform profile lists DO return them — including Facebook's PUBLIC Reel
// plays count, which the Apify facebook-posts-scraper does not expose.

import { loadEnvLocal } from "./load-env";
import type { NormalizedVideo, Platform } from "../src/lib/types";

loadEnvLocal();

const BASE = "https://www.socialcrawl.dev/v1";
const KEY = process.env.SOCIALCRAWL_API_KEY ?? "";
const redact = (s: string) => (KEY ? s.replaceAll(KEY, "sc_***REDACTED***") : s);

// Public campaign profiles (not secrets).
const PROFILES: Record<Exclude<Platform, "youtube">, { path: string }> = {
  tiktok: { path: "/tiktok/profile/videos?handle=cybernick0x" },
  instagram: { path: "/instagram/profile/reels?handle=cybernick0x" },
  facebook: {
    path: `/facebook/profile/reels?url=${encodeURIComponent(
      "https://www.facebook.com/people/Cybernick0x/61585540862384/",
    )}`,
  },
};

interface ScResult {
  items: NormalizedVideo[];
  creditsUsed: number | null;
  cached: boolean | null;
  ok: boolean;
  error?: string;
}

// SocialCrawl unified post shape (only the fields we read).
interface ScPost {
  id?: string;
  url?: string;
  permalink?: string;
  content?: { text?: string; thumbnail_url?: string };
  engagement?: { views?: number; likes?: number; comments?: number; shares?: number; saves?: number };
  published_at?: string;
  created_at?: string;
  author?: { display_name?: string; username?: string };
}
interface ScItem {
  post?: ScPost;
}
interface ScEnvelope {
  data?: ScItem[] | { items?: ScItem[]; reels?: ScItem[]; posts?: ScItem[]; videos?: ScItem[]; results?: ScItem[] };
  credits_used?: number;
  cached?: boolean;
}

async function scGet(path: string): Promise<{ status: number; json: ScEnvelope | null; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "x-api-key": KEY },
    signal: AbortSignal.timeout(45000),
  });
  const text = await res.text();
  let json: ScEnvelope | null = null;
  try {
    json = JSON.parse(text) as ScEnvelope;
  } catch {
    /* keep text */
  }
  return { status: res.status, json, text };
}

function toNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/** Map one SocialCrawl item (shape: { post: { ... } }) → NormalizedVideo. */
function normalize(item: ScItem, platform: Platform): NormalizedVideo | null {
  const post = item.post;
  if (!post) return null;
  const e = post.engagement ?? {};
  return {
    platform,
    originalUrl: post.url ?? post.permalink ?? null,
    externalVideoId: post.id ?? null,
    title: typeof post.content?.text === "string" ? post.content.text.slice(0, 80) : null,
    caption: post.content?.text ?? null,
    thumbnailUrl: post.content?.thumbnail_url ?? null,
    publishedAt: post.published_at ?? post.created_at ?? null,
    authorName: post.author?.display_name ?? null,
    authorHandle: post.author?.username ?? null,
    views: toNumber(e.views), // Facebook: PUBLIC Reel plays (the whole point)
    likes: toNumber(e.likes),
    comments: toNumber(e.comments),
    shares: toNumber(e.shares),
    saves: toNumber(e.saves),
    bookmarks: null,
    rawJson: null, // benchmark: do not retain raw payloads
  };
}

async function fetchPlatform(platform: Exclude<Platform, "youtube">): Promise<ScResult> {
  const r = await scGet(PROFILES[platform].path);
  if (r.status !== 200) {
    return { items: [], creditsUsed: r.json?.credits_used ?? null, cached: null, ok: false, error: redact((r.text || "").slice(0, 160)) };
  }
  const d = r.json?.data;
  const rawItems: ScItem[] = Array.isArray(d)
    ? d
    : d?.items ?? d?.reels ?? d?.posts ?? d?.videos ?? d?.results ?? [];
  const items = rawItems.map((it) => normalize(it, platform)).filter((v): v is NormalizedVideo => v !== null);
  return { items, creditsUsed: r.json?.credits_used ?? null, cached: Boolean(r.json?.cached), ok: true };
}

async function main() {
  if (!KEY) {
    console.error("SOCIALCRAWL_API_KEY is not set — add it to .env.local (untracked). Aborting (no calls made).");
    process.exit(1);
  }
  console.log("SocialCrawl shadow refresh (dry-run · no Apify · no DB writes · YouTube excluded → Data API)\n");

  const platforms: Array<Exclude<Platform, "youtube">> = ["tiktok", "instagram", "facebook"];
  let grandViews = 0;
  let creditsTotal = 0;

  for (const platform of platforms) {
    const r = await fetchPlatform(platform);
    if (r.creditsUsed) creditsTotal += r.creditsUsed;
    if (!r.ok) {
      console.log(`■ ${platform}: ERROR — ${r.error}`);
      continue;
    }
    const withViews = r.items.filter((v) => v.views !== null);
    const sum = withViews.reduce((s, v) => s + (v.views ?? 0), 0);
    grandViews += sum;
    console.log(`■ ${platform.toUpperCase()}  (credits_used=${r.creditsUsed} cached=${r.cached})`);
    console.log(`  posts=${r.items.length}  with-views=${withViews.length}  Σviews=${sum.toLocaleString()}`);
    for (const v of [...withViews].sort((a, b) => (b.views ?? 0) - (a.views ?? 0)).slice(0, 6)) {
      const id = (v.originalUrl ?? v.externalVideoId ?? "").slice(-34);
      console.log(
        `    views=${String(v.views).padStart(8)}  likes=${String(v.likes ?? "-").padStart(6)}  comments=${String(v.comments ?? "-").padStart(5)}  shares=${String(v.shares ?? "-").padStart(5)}  thumb=${Boolean(v.thumbnailUrl)}  …${id}`,
      );
    }
    console.log("");
  }

  console.log(`Σ TikTok+Instagram+Facebook shadow views = ${grandViews.toLocaleString()}`);
  console.log(`SocialCrawl credits used this run = ${creditsTotal} (cache hits cost 0)`);
  console.log("YouTube is unchanged — it stays on the official YouTube Data API (excluded from SocialCrawl).");
  console.log("\nDry-run only: no snapshots written, no provider routing changed.");
}

main().catch((e) => {
  console.error(redact(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
