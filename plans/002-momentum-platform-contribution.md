# Plan 002: Platform contribution visible by default in Campaign Momentum

## Status

- **Priority**: P2
- **Effort**: S (verify + harden; core already built)
- **Risk**: LOW
- **Depends on**: 001 must be verified in production first
- **Category**: feature / tests
- **Planned at**: commit `40368f9`, 2026-06-13

## Why this matters

The Campaign Momentum chart should show, in its **default** view, which
platform drove growth — not behind a menu — while the cumulative total line
stays dominant.

## Current state (audit finding)

This was implemented in Phase 3.8 and is live in
`src/components/charts/momentum-chart.tsx`:

- Default mode is `total` (`useState<ChartMode>("total")`).
- In total mode it renders soft **stacked platform `Area`s** (`stackId="platforms"`,
  `fillOpacity 0.16`, platform colors: TikTok `#25f4ee`, YouTube `#ff4444`,
  Instagram `#e95daa`, Facebook `#4b8dff`) BENEATH the dominant total line
  (`strokeWidth 2.5`, drawn last) — visible by default, no separate menu.
- A `Total` / `Velocity` toggle exists; Velocity stacks real per-interval
  deltas (`g_<platform>_<metric>`, positive real deltas only).
- Tooltip shows per-platform totals + interval gains + share % + top
  contributor; surge annotations (`findSurges`) mark up to 2 real jumps.
- Reduced motion respected (`useSyncExternalStore` on the media query;
  `isAnimationActive={!reducedMotion}`).
- Per-platform data comes from `data.trendByPlatform` (real snapshots).

So Priority 2's requirement is already met. Work here is **confirmation +
regression tests** so it cannot silently regress, plus a visual check.

## Scope

**In scope**: `tests/chart-modes.test.ts` (extend, do not remove existing).
**Out of scope**: rebuilding the chart, removing the velocity mode, the data
pipeline.

## Tests to confirm/extend

- platform stack renders in DEFAULT total mode (`stackId="platforms"` +
  `useState<ChartMode>("total")`).
- total line drawn after/over the stack and remains (dominant).
- velocity plots real per-interval deltas; missing readings never become 0.
- tooltip exposes platform totals, share %, top contributor.
- reduced-motion gating present.
(Existing `tests/chart-modes.test.ts` already covers most; verify all green.)

## Done criteria

- `npx vitest run tests/chart-modes.test.ts` all pass
- Visual: load `/`, confirm colored bands under the line by default; the line
  stays the clear focal element; toggle Total/Velocity works.
