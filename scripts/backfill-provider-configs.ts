// One-off: copy the locally-tested ProviderConfig rows (capability flags,
// actor IDs, test results) into the database pointed at by DATABASE_URL.
// Used to backfill the fresh Supabase production DB with the actor test
// results performed during development.
//
//   DATABASE_URL=... npx tsx scripts/backfill-provider-configs.ts

import { loadEnvLocal } from "./load-env";
import { readFileSync } from "fs";
import path from "path";

async function main() {
  const target = process.env.DATABASE_URL?.trim();
  if (!target) {
    console.error("Set DATABASE_URL to the target database.");
    process.exit(1);
  }
  // Source: the local JSON store (read directly so loadEnvLocal can't flip it)
  const localDb = JSON.parse(
    readFileSync(path.join(process.cwd(), "data", "local-db.json"), "utf-8"),
  ) as { providerConfigs?: Array<Record<string, unknown>> };
  const configs = localDb.providerConfigs ?? [];
  if (configs.length === 0) {
    console.error("No local provider configs to copy.");
    process.exit(1);
  }

  loadEnvLocal(); // for anything else; DATABASE_URL already set explicitly
  const { getStore } = await import("../src/lib/store");
  const store = getStore();
  const info = store.info();
  if (info.kind !== "postgres") {
    console.error(`Target store is ${info.kind}, expected postgres — aborting.`);
    process.exit(1);
  }

  for (const c of configs) {
    const existing = await store.getProviderConfig(c.platform as never);
    await store.upsertProviderConfig({
      platform: c.platform as never,
      providerType: (c.providerType as never) ?? "apify",
      actorId: (c.actorId as string) ?? null,
      status: (c.status as never) ?? "live",
      lastTestedAt: (c.lastTestedAt as string) ?? null,
      lastTestResult: (c.lastTestResult as never) ?? null,
      detectedFields: (c.detectedFields as string[]) ?? [],
      supportsMetadata: Boolean(c.supportsMetadata),
      supportsMetrics: Boolean(c.supportsMetrics),
      supportsComments: Boolean(c.supportsComments),
      supportsDiscovery: Boolean(c.supportsDiscovery),
      inputOverride: (c.inputOverride as never) ?? null,
      // Keep the production refresh timestamp if the row already has one.
      lastSuccessfulRefreshAt:
        existing?.lastSuccessfulRefreshAt ?? (c.lastSuccessfulRefreshAt as string) ?? null,
    });
    console.log(`upserted ${c.platform} config (comments=${Boolean(c.supportsComments)})`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message.slice(0, 300) : e);
  process.exit(1);
});
