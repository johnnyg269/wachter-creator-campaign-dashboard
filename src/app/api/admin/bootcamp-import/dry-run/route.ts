// POST /api/admin/bootcamp-import/dry-run — admin-only. Runs the Bootcamp import
// DRY RUN: resolves the anchors (1 SocialCrawl credit each on TT/IG/FB; free on
// YouTube), auto-enumerates YouTube uploads from the start date (free Data API),
// and classifies pasted/anchor candidates against existing records. NEVER writes
// a video. The write/approve step lands in Phase 2B.

import { NextResponse, type NextRequest } from "next/server";
import { getStore } from "@/lib/store";
import { resolveProvider } from "@/lib/providers/registry";
import { YouTubeApiProvider } from "@/lib/providers/youtube-api-provider";
import {
  parseImportConfig,
  runBootcampDryRun,
  type BootcampProviderAdapter,
} from "@/lib/bootcamp-import";
import { isSocialcrawlPlatform } from "@/lib/credit-policy";
import { bearerMatches, checkAdminRequest } from "@/lib/auth";
import { getAdminPassword, getCronSecret } from "@/lib/config";
import type { Platform } from "@/lib/types";
import { readJsonObject, serverError } from "../../_utils";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Admin-only, but (like repair-thumbnails / refresh) also accepts the server
// CRON_SECRET as a constant-time Bearer header so the SAME read-only dry run can
// be triggered server-side for verification. Fail-closed when neither is set.
function authorized(req: NextRequest): boolean {
  if (!getAdminPassword() && !getCronSecret()) return false;
  if (checkAdminRequest(req) === null) return true;
  return bearerMatches(req.headers.get("authorization"), getCronSecret());
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await readJsonObject(req)) ?? {};
    const config = parseImportConfig(body);
    const store = getStore();

    const getProvider = async (platform: Platform): Promise<BootcampProviderAdapter | null> => {
      const { provider, readiness } = await resolveProvider(platform, store);
      if (!readiness.ready) return null; // not connected → skip (dry run notes it)
      const adapter: BootcampProviderAdapter = {
        // Resolving an anchor spends a real SocialCrawl credit (TT/IG/FB), so log
        // it as a CollectionAttempt — otherwise dry-run spend stays invisible to
        // socialcrawlCreditsToday()/the admin panel and the daily cap is
        // understated for the next scheduled refresh. (YouTube /post is free.)
        getVideoMetadata: async (url) => {
          const result = await provider.getVideoMetadata(url);
          if (isSocialcrawlPlatform(platform)) {
            await store.addCollectionAttempt({
              refreshRunId: null,
              platform,
              provider: "socialcrawl",
              actorId: null,
              kind: "detail",
              inputDescription: `socialcrawl ${platform} dry-run anchor · 1cr · cache:miss`,
              success: Boolean(result),
              runId: null,
              itemCount: result ? 1 : 0,
              error: result ? null : "anchor did not resolve",
              capturedAt: new Date().toISOString(),
            });
          }
          return result;
        },
      };
      if (platform === "youtube" && provider instanceof YouTubeApiProvider) {
        const profile = (await store.listProfiles()).find((p) => p.platform === "youtube") ?? null;
        if (profile) {
          adapter.listRecentUploads = (since, maxPages) => provider.listRecentUploads(profile, since, maxPages);
        }
      }
      return adapter;
    };

    const attempts = await store.listCollectionAttempts(4000);
    const report = await runBootcampDryRun(store, config, { getProvider, attempts });

    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return serverError(e, "Bootcamp dry run failed");
  }
}
