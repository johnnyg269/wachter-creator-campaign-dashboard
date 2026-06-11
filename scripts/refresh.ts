// CLI: run a full refresh locally (same pipeline as /api/refresh).
//   npm run refresh

import { loadEnvLocal } from "./load-env";
loadEnvLocal();

async function main() {
  const { runRefresh } = await import("../src/lib/refresh");
  console.log("Running refresh…");
  const report = await runRefresh("script");
  console.log(`\nStatus: ${report.status}  (${report.startedAt} → ${report.finishedAt})`);
  for (const p of report.platforms) {
    console.log(
      `  ${p.platform.padEnd(10)} ${p.status.padEnd(8)} videos=${p.videosUpdated} comments=${p.commentsUpdated} discovered=${p.newVideosDiscovered}${p.reason ? `  (${p.reason})` : ""}`,
    );
  }
  if (report.errors.length > 0) {
    console.log("\nErrors:");
    for (const e of report.errors) console.log(`  - ${e}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
