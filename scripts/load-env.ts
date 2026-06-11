// Minimal .env.local loader for CLI scripts (Next.js loads it automatically
// for the app itself; tsx scripts need this). Values already present in the
// environment win.

import { readFileSync } from "fs";
import path from "path";

export function loadEnvLocal(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      const raw = readFileSync(path.join(process.cwd(), file), "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch {
      // file absent — fine
    }
  }
}
