// Campaign Milestones — a rule-based engine that surfaces meaningful, REAL
// campaign achievements from the current metrics. Pure + client-safe (no store,
// no queries, no secrets): callers pass a plain MilestoneInput derived from
// already-loaded dashboard/report data, and get back a list of milestones.
//
// Data-integrity rules (enforced here, not just by convention):
//   - Milestones are only emitted when the underlying real value supports them.
//   - Unavailable values (null) never count as zero and never fire a milestone.
//   - No invented history. Threshold milestones reflect the CURRENT crossed
//     level; we do NOT claim a first-crossed date we don't have (see below).
//
// Persistence note (Phase 7, Part 3F): milestones are computed DYNAMICALLY from
// the latest snapshots. We do not persist "first crossed" events — that would
// need a schema migration, and the production database isn't reachable from the
// build environment to run one safely. Consequence: threshold milestones carry
// no exact crossing date (date = null) and read as present-tense achievements
// ("Campaign passed 1.5M total views"), never "crossed on <date>". The one
// milestone with a real date is the growth-velocity peak, whose date comes
// straight from the snapshot trend.

import type { Platform } from "./types";

export type MilestoneType =
  | "reach"
  | "growth_velocity"
  | "platform_leadership"
  | "video_performance"
  | "engagement"
  | "comment"
  | "concept";

export type MilestoneSeverity = "major" | "notable" | "minor";

export interface Milestone {
  id: string;
  type: MilestoneType;
  title: string;
  description: string;
  value: number | null;
  /** ISO date when this is genuinely known (growth-velocity peak); else null. */
  date: string | null;
  platform?: Platform;
  videoTitle?: string;
  conceptName?: string;
  severity: MilestoneSeverity;
}

export interface MilestoneInput {
  totalViews: number | null;
  totalEngagements: number | null;
  totalComments: number | null;
  /** Real views gained across the selected period. */
  periodViewsGained: number | null;
  rangeLabel: string;
  platforms: Array<{
    platform: Platform;
    label: string;
    views: number | null;
    viewsGained: number | null;
  }>;
  topVideo: { title: string; platform: Platform; views: number | null } | null;
  /** Real view-trend buckets for the period — drives the peak-growth signal. */
  trend?: Array<{ t: string; views: number | null }>;
  /** Leading content concept, when available. */
  topConcept?: { name: string; views: number | null } | null;
}

// Threshold ladders (ascending). Only the HIGHEST crossed rung fires, so we
// never spam every level the campaign has already passed.
const REACH_STEPS = [
  50_000, 100_000, 250_000, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000,
  4_000_000, 5_000_000,
];
const ENGAGEMENT_STEPS = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000];
const COMMENT_STEPS = [100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const VIDEO_STEPS = [100_000, 250_000, 500_000, 1_000_000, 2_000_000];

function highestCrossed(value: number | null, steps: number[]): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  let crossed: number | null = null;
  for (const step of steps) if (value >= step) crossed = step;
  return crossed;
}

/** Compact label for thresholds: 5,000,000 → "5M", 1,500,000 → "1.5M", 500,000 → "500K". */
export function compactThreshold(n: number): string {
  if (n >= 1_000_000) return `${n % 1_000_000 === 0 ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

const commas = (n: number) => new Intl.NumberFormat("en-US").format(n);
const sharePct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const firstWord = (label: string) => label.split(" ")[0];
const clip = (s: string, max = 64) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const SEVERITY_RANK: Record<MilestoneSeverity, number> = { major: 0, notable: 1, minor: 2 };

/**
 * Compute every supported milestone from the real input. Order is not
 * significant; callers use selectTopMilestones to rank + cap.
 */
export function computeMilestones(input: MilestoneInput): Milestone[] {
  const out: Milestone[] = [];

  // 1 — Total reach
  const reach = highestCrossed(input.totalViews, REACH_STEPS);
  if (reach !== null) {
    out.push({
      id: `reach-${reach}`,
      type: "reach",
      title: `${compactThreshold(reach)} views crossed`,
      description: `Campaign passed ${commas(reach)} total views.`,
      value: reach,
      date: null,
      severity: reach >= 1_000_000 ? "major" : "notable",
    });
  }

  // 2 — Growth velocity (peak single tracked window, from the real trend)
  if (input.trend && input.trend.length >= 2) {
    let best: { gain: number; date: string } | null = null;
    for (let i = 1; i < input.trend.length; i++) {
      const a = input.trend[i - 1].views;
      const b = input.trend[i].views;
      if (a !== null && b !== null) {
        const gain = b - a;
        if (gain > 0 && (best === null || gain > best.gain)) best = { gain, date: input.trend[i].t };
      }
    }
    if (best && best.gain > 0) {
      out.push({
        id: "velocity-peak",
        type: "growth_velocity",
        title: "Peak growth window",
        description: `Strongest tracked surge: +${commas(best.gain)} views in a single window.`,
        value: best.gain,
        date: best.date,
        severity: best.gain >= 50_000 ? "major" : "notable",
      });
    }
  }

  // 3 — Platform leadership (by total views, and by period growth)
  const withViews = input.platforms.filter((p) => p.views !== null && (p.views ?? 0) > 0);
  const totalPlatformViews = withViews.reduce((s, p) => s + (p.views ?? 0), 0);
  const viewsLeader = [...withViews].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0] ?? null;

  const withGrowth = input.platforms.filter((p) => p.viewsGained !== null && (p.viewsGained ?? 0) > 0);
  const totalPlatformGrowth = withGrowth.reduce((s, p) => s + (p.viewsGained ?? 0), 0);
  const growthLeader = [...withGrowth].sort((a, b) => (b.viewsGained ?? 0) - (a.viewsGained ?? 0))[0] ?? null;

  if (growthLeader && totalPlatformGrowth > 0) {
    const share = sharePct(growthLeader.viewsGained ?? 0, totalPlatformGrowth);
    out.push({
      id: `lead-growth-${growthLeader.platform}`,
      type: "platform_leadership",
      title: `${firstWord(growthLeader.label)} leads growth`,
      description: `${growthLeader.label} drove ${share}% of views gained over ${input.rangeLabel}.`,
      value: growthLeader.viewsGained,
      date: null,
      platform: growthLeader.platform,
      severity: share >= 50 ? "major" : "notable",
    });
  }
  // Only add the total-views leader when it's a DIFFERENT platform than the
  // growth leader (otherwise it's the same story told twice).
  if (viewsLeader && totalPlatformViews > 0 && viewsLeader.platform !== growthLeader?.platform) {
    const share = sharePct(viewsLeader.views ?? 0, totalPlatformViews);
    out.push({
      id: `lead-views-${viewsLeader.platform}`,
      type: "platform_leadership",
      title: `${firstWord(viewsLeader.label)} leads the campaign`,
      description: `${viewsLeader.label} drives ${share}% of total campaign views.`,
      value: viewsLeader.views,
      date: null,
      platform: viewsLeader.platform,
      severity: "notable",
    });
  }

  // 4 — Top video performance
  if (input.topVideo && input.topVideo.views !== null) {
    const crossed = highestCrossed(input.topVideo.views, VIDEO_STEPS);
    if (crossed !== null) {
      out.push({
        id: `video-${crossed}`,
        type: "video_performance",
        title: `Top video crossed ${compactThreshold(crossed)}`,
        description: `${clip(input.topVideo.title)} reached ${commas(input.topVideo.views)} views.`,
        value: crossed,
        date: null,
        platform: input.topVideo.platform,
        videoTitle: input.topVideo.title,
        severity: crossed >= 1_000_000 ? "major" : "notable",
      });
    }
  }

  // 5 — Engagement
  const engage = highestCrossed(input.totalEngagements, ENGAGEMENT_STEPS);
  if (engage !== null) {
    out.push({
      id: `engage-${engage}`,
      type: "engagement",
      title: `${compactThreshold(engage)} engagements reached`,
      description: `Campaign passed ${commas(engage)} total engagements (likes, comments, shares).`,
      value: engage,
      date: null,
      severity: engage >= 100_000 ? "major" : "notable",
    });
  }

  // 6 — Comments
  const comment = highestCrossed(input.totalComments, COMMENT_STEPS);
  if (comment !== null) {
    out.push({
      id: `comment-${comment}`,
      type: "comment",
      title: `${commas(comment)} comments reached`,
      description: `The audience has left ${commas(comment)}+ comments across the campaign.`,
      value: comment,
      date: null,
      severity: comment >= 1_000 ? "notable" : "minor",
    });
  }

  // 7 — Leading content concept
  if (input.topConcept && input.topConcept.views !== null && input.topConcept.views > 0) {
    out.push({
      id: "concept-leader",
      type: "concept",
      title: `${clip(input.topConcept.name, 40)} is the leading theme`,
      description: `${clip(input.topConcept.name, 40)} leads all content concepts with ${commas(input.topConcept.views)} views.`,
      value: input.topConcept.views,
      date: null,
      conceptName: input.topConcept.name,
      severity: "minor",
    });
  }

  return out;
}

/**
 * Rank by importance (severity, then value) and cap. Milestones are already
 * de-duplicated at emit time (one reach/engagement/comment, platform leaders
 * only when distinct), so this is a stable sort + slice.
 */
export function selectTopMilestones(milestones: Milestone[], limit: number): Milestone[] {
  return [...milestones]
    .sort((a, b) => {
      const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (s !== 0) return s;
      return (b.value ?? 0) - (a.value ?? 0);
    })
    .slice(0, Math.max(0, limit));
}

/** The single most important milestone (for the board report), or null. */
export function topMilestone(milestones: Milestone[]): Milestone | null {
  return selectTopMilestones(milestones, 1)[0] ?? null;
}
