// Re-runs keyword tagging + sentiment classification over all stored comments.
// Run after changing the rules in src/lib/intel so existing comments pick up
// new tags (e.g. the "watcher" misspelling):  npx tsx scripts/retag-comments.ts
//
// upsertComment refreshes derived fields (tags/sentiment/needsResponse) on
// dedupe, so re-upserting each comment with freshly computed values is enough.

import { loadEnvLocal } from "./load-env";
loadEnvLocal();

async function main() {
  const { getStore } = await import("../src/lib/store");
  const { tagComment } = await import("../src/lib/intel/keywords");
  const { classifyComment } = await import("../src/lib/intel/sentiment");

  const store = getStore();
  const comments = await store.listComments({ limit: 10_000 });
  let changed = 0;
  for (const c of comments) {
    const tags = tagComment(c.text);
    const cls = classifyComment(c.text, tags);
    if (
      JSON.stringify(tags) === JSON.stringify(c.tags) &&
      cls.sentiment === c.sentiment &&
      cls.needsResponse === c.needsResponse
    ) {
      continue;
    }
    await store.upsertComment({
      ...c,
      tags,
      sentiment: cls.sentiment,
      needsResponse: cls.needsResponse,
    });
    changed++;
  }
  console.log(`retagged ${changed}/${comments.length} comments`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
