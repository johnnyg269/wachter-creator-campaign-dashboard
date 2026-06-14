# Implementation plans

Generated following the `shadcn/improve` skill methodology (installed at
`.agents/skills/improve`, symlinked into `.claude/skills/improve`). The
`/improve` slash command is not registered in this Claude Code harness, so the
audit + planning workflow was run manually; these plans are the deliverable.

Planned at commit `40368f9`, 2026-06-13.

| # | Plan | Priority | Status |
|---|------|----------|--------|
| 001 | Fix episode-concept deletion so deleted concepts never reappear | P1 | DONE |
| 002 | Show platform contribution by default in the Campaign Momentum chart | P2 | DONE (pre-existing; verified + hardened) |

## Execution order

001 must land, be tested, and be verified in production **before** 002 begins
(explicit user requirement). 002 has no dependency on 001's code.

## Audit summary

Read-only audit of every path that can create/seed/fetch/merge/display/cache
episode concepts (`grep` for `DEFAULT_EPISODE_GROUPS`, `ensureSeedData`,
`upsertEpisodeGroupByName`, `listEpisodeGroups`, `deleteEpisodeGroup`, all
`ensureSeedData` call sites). Single root cause found — see plan 001.

Campaign Momentum platform-contribution (002) was already implemented in a
prior phase (`src/components/charts/momentum-chart.tsx`). The audit verified it
renders by default and reconciles with real data; remaining work is
confirmation + regression-test hardening, not a rebuild.
