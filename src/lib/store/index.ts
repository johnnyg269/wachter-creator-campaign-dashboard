// Store factory: Postgres (Prisma) when DATABASE_URL is set, otherwise the
// local JSON file store. Cached on globalThis so dev hot-reload and
// concurrent route handlers share one instance.

import type { Store } from "./types";
import { JsonStore } from "./json-store";

const globalForStore = globalThis as unknown as { __wachterStore?: Store };

export function getStore(): Store {
  if (globalForStore.__wachterStore) return globalForStore.__wachterStore;
  let store: Store;
  if (process.env.DATABASE_URL?.trim()) {
    // Lazy require so the app builds/runs without a database configured.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaStore } = require("./prisma-store") as typeof import("./prisma-store");
    store = new PrismaStore();
  } else {
    store = new JsonStore();
  }
  globalForStore.__wachterStore = store;
  return store;
}

export type { Store, StoreInfo, VideoFilter, CommentFilter } from "./types";
