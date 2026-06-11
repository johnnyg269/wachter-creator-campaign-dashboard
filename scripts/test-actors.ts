// CLI: test candidate Apify actors against the campaign seed URLs and persist
// the results to ProviderConfig — the same code path the /admin "Test actor"
// button uses.
//
//   npm run test:actors                  # test all candidates
//   npm run test:actors -- tiktok        # test candidates for one platform
//   npm run test:actors -- tiktok GdWCkxBtKWOsKjdch   # specific actor

import { loadEnvLocal } from "./load-env";
loadEnvLocal();

async function main() {
  const { CANDIDATE_ACTORS } = await import("../src/lib/config");
  const { getStore } = await import("../src/lib/store");
  const { testActor } = await import("../src/lib/apify/actor-test");
  const { checkToken, getActorInfo } = await import("../src/lib/apify/client");
  const { ensureSeedData } = await import("../src/lib/seed");

  const [platformArg, actorArg] = process.argv.slice(2);
  const store = getStore();
  await ensureSeedData(store);

  const token = await checkToken();
  if (!token.configured || !token.valid) {
    console.error(
      `✗ Apify token ${!token.configured ? "missing" : "invalid"} — set APIFY_TOKEN in .env.local`,
    );
    process.exit(1);
  }
  console.log(`✓ Apify token valid (account: ${token.username})\n`);

  let candidates = CANDIDATE_ACTORS;
  if (platformArg) candidates = candidates.filter((c) => c.platform === platformArg);
  if (actorArg) candidates = candidates.filter((c) => c.actorId === actorArg);
  if (candidates.length === 0) {
    console.error("No matching candidate actors.");
    process.exit(1);
  }

  for (const candidate of candidates) {
    console.log(`── Testing ${candidate.name} (${candidate.actorId}) for ${candidate.platform} ──`);
    try {
      const info = await getActorInfo(candidate.actorId);
      console.log(`   actor: ${info.username}/${info.name} — ${info.title ?? "(no title)"}`);
    } catch (e) {
      console.log(`   ✗ actor lookup failed: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    const result = await testActor({
      platform: candidate.platform,
      actorId: candidate.actorId,
      store,
      // Only persist as the active provider config if this is the platform's
      // first tested actor or it succeeded — never overwrite a working config
      // with a failed one.
      save: true,
    });
    console.log(`   input:    ${result.inputDescription}`);
    console.log(`   items:    ${result.itemCount}  (${result.durationMs ?? "?"}ms)`);
    if (result.ok && result.normalizedPreview) {
      const p = result.normalizedPreview;
      console.log(`   ✓ normalized: views=${p.views} likes=${p.likes} comments=${p.comments} shares=${p.shares}`);
      console.log(`     title: ${(p.title ?? "").slice(0, 70)}`);
      console.log(`     published: ${p.publishedAt}  url: ${p.originalUrl}`);
    } else {
      console.log(`   ✗ ${result.error}`);
    }
    console.log(`   fields: ${result.detectedFields.slice(0, 15).join(", ")}${result.detectedFields.length > 15 ? "…" : ""}\n`);
  }

  const configs = await store.listProviderConfigs();
  console.log("── Provider config summary ──");
  for (const c of configs) {
    console.log(
      `   ${c.platform.padEnd(10)} actor=${c.actorId ?? "—"} status=${c.status} metadata=${c.supportsMetadata} metrics=${c.supportsMetrics} comments=${c.supportsComments} discovery=${c.supportsDiscovery}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
