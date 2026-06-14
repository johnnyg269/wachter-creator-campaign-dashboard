# Plan 001: Deleted episode concepts stay deleted permanently

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `40368f9`, 2026-06-13

## Why this matters

Deleting an episode/content concept in admin removes it briefly, then it
reappears at the bottom of the list. Root cause (confirmed): `ensureSeedData()`
runs on **every page load** (via `getHealth()` in `src/lib/queries.ts:75`) and
**every refresh** (`src/lib/refresh.ts:176`), and unconditionally re-seeds the
seven `DEFAULT_EPISODE_GROUPS` by calling `upsertEpisodeGroupByName`. When a
default was deleted, the upsert finds no row with that name and **creates a new
one** — new `id`, new `createdAt` — so it returns at the bottom (the Prisma
list orders by `createdAt asc`). The reappearing concept therefore has a **new
ID and new createdAt**, recreated by `ensureSeedData` → `upsertEpisodeGroupByName`.

The DB schema cannot be migrated from this environment (production
`DATABASE_URL` is stored sensitive; `vercel env pull` returns it empty), so a
new `deletedAt` column is not deployable. Instead we use the existing,
already-written `ManualOverride` audit row as a durable tombstone (no
migration), plus a hard rule that seeding only runs at true initial setup.

## Current state

- `src/lib/seed.ts:24-26` — the bug:
  ```ts
  for (const name of DEFAULT_EPISODE_GROUPS) {
    await store.upsertEpisodeGroupByName({ campaignId: campaign.id, name, description: null });
  }
  ```
- `ensureSeedData` callers (all re-trigger the loop): `src/lib/queries.ts:75`
  (`getHealth`, every public + admin page), `:118` (`getDashboardData`),
  `src/lib/refresh.ts:176` (every refresh), and three admin API routes.
- Delete route already writes a durable tombstone:
  `src/app/api/admin/episodes/[id]/route.ts:98` →
  `addOverride({ entityType:"episode", field:"deleted", oldValue:<name> })`.
  Create route writes `{ field:"created", newValue:<name> }` (`route.ts:36`).
- `store.listOverrides(limit?)` and `store.listEpisodeGroups()` exist on both
  `JsonStore` and `PrismaStore` (`src/lib/store/types.ts:78,101`).
- `deleteEpisodeGroup(id, replacementId)` hard-deletes the row and reassigns
  member videos to the replacement or `null` — keep this behavior.

## Scope

**In scope**: `src/lib/seed.ts`, `tests/episode-deletion.test.ts` (create).
**Out of scope**: Prisma schema, store interfaces, the admin routes (already
correct), the chart. Do NOT add a `deletedAt` column.

## Implementation

Replace the seeding loop with a guarded helper:

1. Seed default episodes **only when `listEpisodeGroups()` is empty** (true
   initial setup, or an all-deleted DB). If any concept exists, return without
   touching episodes — admin is the sole authority thereafter.
2. Even at zero concepts, skip any default whose **latest** episode override is
   a delete (tombstone), derived from `listOverrides`: `created→newValue`,
   `deleted→oldValue`, newest `createdAt` per name wins. `console.info` each skip.

## Tests (`tests/episode-deletion.test.ts`, JsonStore)

- delete a zero-video concept → gone; `ensureSeedData` does NOT recreate it
  (simulates admin reload / public load / refresh — all call `ensureSeedData`).
- deleted default not recreated while other concepts exist (no reseed at all).
- deleted default not recreated even at zero concepts (tombstone honored).
- no new row with the deleted name/new id appears after `ensureSeedData`.
- fresh store with zero concepts + zero tombstones → all 7 defaults seeded once;
  second `ensureSeedData` adds no duplicates.
- assigned-video delete reassigns members to null/replacement, concept gone.

## Done criteria

- `npx tsc --noEmit` exit 0
- `npx vitest run` all pass (incl. new file)
- `npm run lint` exit 0

## STOP conditions

- If `ensureSeedData` turns out to have another episode-creating path beyond
  the loop, stop and report.
- If `listOverrides` is not populated by the delete route in production, the
  zero-count gate still fixes the reported single-delete bug; note it.
