"use client";

// Interactive comment feed: summary strip, filters (platform / video /
// episode / sentiment / tags / search), sorting, and client-side pagination.
// All counting in the summary strip reflects the full dataset; the list below
// reflects the active filters.

import { useMemo, useState } from "react";
import clsx from "clsx";
import {
  ExternalLink,
  Heart,
  Layers,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Reply,
  Search,
  X,
} from "lucide-react";
import type { Comment, EpisodeGroup, Platform, Sentiment, Video } from "@/lib/types";
import { PLATFORMS, PLATFORM_LABELS } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { ClearableInput } from "@/components/ui/clearable-input";
import { EmptyState } from "@/components/ui/empty-state";
import { PLATFORM_COLORS, PlatformBadge, PlatformDot } from "@/components/ui/platform";
import { TimeAgo } from "@/components/ui/time-ago";
import { VideoThumb } from "@/components/ui/video-thumb";
import { formatCompact, formatNumber, truncate } from "@/lib/format";

// rawJson is intentionally omitted from the public payload (server strips it).
export type FeedComment = Omit<Comment, "rawJson"> & { video: Video | null; episodeName: string | null };

type SentimentFilter = "all" | Sentiment | "needs_response";
type SortKey = "newest" | "likes";

const PAGE_SIZE = 100;

const SENTIMENT_CHIP: Record<Sentiment, string> = {
  positive: "text-positive bg-[rgba(52,211,153,0.1)]",
  neutral: "text-muted bg-surface-hover",
  negative: "text-negative bg-[rgba(248,113,113,0.12)]",
  question: "text-accent bg-[rgba(59,130,246,0.1)]",
};

const SENTIMENT_LABEL: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  question: "Question",
};

const SELECT_CLASS =
  "rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors focus:border-border-strong";

const PILL_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors";
const PILL_INACTIVE =
  "border-border bg-surface text-muted hover:bg-surface-hover hover:text-foreground";

/** Sort/display key: when the platform didn't expose postedAt, fall back to capture time. */
function recency(c: FeedComment): string {
  return c.postedAt ?? c.capturedAt;
}

export function CommentFeed({
  comments,
  videos,
  episodes,
}: {
  comments: FeedComment[];
  videos: Video[];
  episodes: EpisodeGroup[];
}) {
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [videoId, setVideoId] = useState<string>("all");
  const [episodeId, setEpisodeId] = useState<string>("all");
  const [sentiment, setSentiment] = useState<SentimentFilter>("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const resetPage = () => setVisibleCount(PAGE_SIZE);

  const stats = useMemo(
    () => ({
      total: comments.length,
      questions: comments.filter((c) => c.sentiment === "question").length,
      needsResponse: comments.filter((c) => c.needsResponse).length,
      positive: comments.filter((c) => c.sentiment === "positive").length,
      neutral: comments.filter((c) => c.sentiment === "neutral").length,
      negative: comments.filter((c) => c.sentiment === "negative").length,
    }),
    [comments],
  );

  const platformCounts = useMemo(() => {
    const counts: Record<Platform, number> = { tiktok: 0, youtube: 0, instagram: 0, facebook: 0 };
    for (const c of comments) counts[c.platform]++;
    return counts;
  }, [comments]);

  /** Union of tags present, sorted by frequency then alphabetically. */
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of comments) for (const t of c.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [comments]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return comments.filter((c) => {
      if (platform !== "all" && c.platform !== platform) return false;
      if (videoId !== "all" && c.videoId !== videoId) return false;
      if (episodeId !== "all" && c.video?.episodeGroupId !== episodeId) return false;
      if (sentiment === "needs_response") {
        if (!c.needsResponse) return false;
      } else if (sentiment !== "all" && c.sentiment !== sentiment) {
        return false;
      }
      if (selectedTags.length > 0 && !selectedTags.every((t) => c.tags.includes(t))) return false;
      if (q) {
        const hay = `${c.text} ${c.authorName ?? ""} ${c.tags.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [comments, platform, videoId, episodeId, sentiment, selectedTags, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sort === "newest") {
      arr.sort((a, b) => recency(b).localeCompare(recency(a)));
    } else {
      arr.sort((a, b) => {
        // Most liked, null likes last; recency breaks ties.
        if (a.likes === null && b.likes === null) return recency(b).localeCompare(recency(a));
        if (a.likes === null) return 1;
        if (b.likes === null) return -1;
        if (b.likes !== a.likes) return b.likes - a.likes;
        return recency(b).localeCompare(recency(a));
      });
    }
    return arr;
  }, [filtered, sort]);

  const hasActiveFilters =
    platform !== "all" ||
    videoId !== "all" ||
    episodeId !== "all" ||
    sentiment !== "all" ||
    selectedTags.length > 0 ||
    search.trim() !== "";

  function clearFilters() {
    setPlatform("all");
    setVideoId("all");
    setEpisodeId("all");
    setSentiment("all");
    setSelectedTags([]);
    setSearch("");
    resetPage();
  }

  function toggleSentimentFilter(value: Exclude<SentimentFilter, "all">) {
    setSentiment((s) => (s === value ? "all" : value));
    resetPage();
  }

  function toggleTag(tag: string) {
    setSelectedTags((tags) =>
      tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag],
    );
    resetPage();
  }

  if (comments.length === 0) {
    return (
      <EmptyState
        icon={<MessagesSquare size={28} />}
        title="No comments captured yet"
        detail="Comments arrive once a provider with comment support refreshes (TikTok actor or YouTube API)."
      />
    );
  }

  const visible = sorted.slice(0, visibleCount);

  return (
    <div>
      {/* Summary strip — counts cover all captured comments; chips toggle the sentiment filter. */}
      <Card className="mb-4 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
          <div className="mr-3 flex items-center gap-2">
            <MessageSquare size={14} className="text-muted-strong" aria-hidden />
            <span className="tabular text-sm font-semibold">{formatNumber(stats.total)}</span>
            <span className="text-xs text-muted">total</span>
          </div>
          <SummaryChip
            label="questions"
            count={stats.questions}
            dotClass="bg-accent"
            textClass="text-accent"
            active={sentiment === "question"}
            onClick={() => toggleSentimentFilter("question")}
          />
          <SummaryChip
            label="need response"
            count={stats.needsResponse}
            dotClass="bg-warning"
            textClass="text-warning"
            active={sentiment === "needs_response"}
            onClick={() => toggleSentimentFilter("needs_response")}
          />
          <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" aria-hidden />
          <SummaryChip
            label="positive"
            count={stats.positive}
            dotClass="bg-positive"
            textClass="text-positive"
            active={sentiment === "positive"}
            onClick={() => toggleSentimentFilter("positive")}
          />
          <SummaryChip
            label="neutral"
            count={stats.neutral}
            dotClass="bg-muted-strong"
            textClass="text-muted"
            active={sentiment === "neutral"}
            onClick={() => toggleSentimentFilter("neutral")}
          />
          <SummaryChip
            label="negative"
            count={stats.negative}
            dotClass="bg-negative"
            textClass="text-negative"
            active={sentiment === "negative"}
            onClick={() => toggleSentimentFilter("negative")}
          />
        </div>
      </Card>

      {/* Filters */}
      <Card className="mb-4 px-4 py-3.5">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by platform">
              <button
                type="button"
                onClick={() => {
                  setPlatform("all");
                  resetPage();
                }}
                aria-pressed={platform === "all"}
                className={clsx(
                  PILL_BASE,
                  platform === "all"
                    ? "border-border-strong bg-surface-hover text-foreground"
                    : PILL_INACTIVE,
                )}
              >
                All platforms
                <span className="tabular text-muted-strong">{formatCompact(stats.total)}</span>
              </button>
              {PLATFORMS.map((p) => {
                const active = platform === p;
                const colors = PLATFORM_COLORS[p];
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      setPlatform(p);
                      resetPage();
                    }}
                    aria-pressed={active}
                    className={clsx(
                      PILL_BASE,
                      active ? clsx(colors.bg, colors.text, "border-border-strong") : PILL_INACTIVE,
                    )}
                  >
                    <PlatformDot platform={p} />
                    {PLATFORM_LABELS[p]}
                    <span className="tabular text-muted-strong">
                      {formatCompact(platformCounts[p])}
                    </span>
                  </button>
                );
              })}
            </div>
            <label className="flex items-center gap-1.5 text-[11px] text-muted-strong">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="Sort comments"
                className={SELECT_CLASS}
              >
                <option value="newest">Newest first</option>
                <option value="likes">Most liked</option>
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ClearableInput
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                resetPage();
              }}
              onClear={() => {
                setSearch("");
                resetPage();
              }}
              placeholder="Search comments, authors, tags…"
              aria-label="Search comments"
              wrapperClassName="min-w-48 flex-1"
              inputClassName="w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-strong focus:border-border-strong"
              mirrorClassName="pl-8 pr-8 text-xs text-foreground"
              leftIcon={
                <Search
                  size={13}
                  className="pointer-events-none absolute left-2.5 top-1/2 z-[3] -translate-y-1/2 text-muted-strong"
                  aria-hidden
                />
              }
            />
            {videos.length > 0 && (
              <select
                value={videoId}
                onChange={(e) => {
                  setVideoId(e.target.value);
                  resetPage();
                }}
                aria-label="Filter by video"
                className={clsx(SELECT_CLASS, "max-w-64")}
              >
                <option value="all">All videos</option>
                {PLATFORMS.map((p) => {
                  const vids = videos.filter((v) => v.platform === p);
                  if (vids.length === 0) return null;
                  return (
                    <optgroup key={p} label={PLATFORM_LABELS[p]}>
                      {vids.map((v) => (
                        <option key={v.id} value={v.id}>
                          {truncate(v.title ?? v.caption ?? v.originalUrl, 48)}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            )}
            {episodes.length > 0 && (
              <select
                value={episodeId}
                onChange={(e) => {
                  setEpisodeId(e.target.value);
                  resetPage();
                }}
                aria-label="Filter by episode"
                className={SELECT_CLASS}
              >
                <option value="all">All episodes</option>
                {episodes.map((e) => (
                  <option key={e.id} value={e.id}>
                    {truncate(e.name, 40)}
                  </option>
                ))}
              </select>
            )}
            <select
              value={sentiment}
              onChange={(e) => {
                setSentiment(e.target.value as SentimentFilter);
                resetPage();
              }}
              aria-label="Filter by sentiment"
              className={SELECT_CLASS}
            >
              <option value="all">All sentiment</option>
              <option value="positive">Positive</option>
              <option value="neutral">Neutral</option>
              <option value="negative">Negative</option>
              <option value="question">Questions</option>
              <option value="needs_response">Needs response</option>
            </select>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <X size={12} aria-hidden />
                Clear filters
              </button>
            )}
          </div>

          {allTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag">
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-strong">
                Tags
              </span>
              {allTags.map(([tag, count]) => {
                const selected = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    aria-pressed={selected}
                    className={clsx(
                      "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                      selected
                        ? "border-accent bg-[rgba(59,130,246,0.1)] text-accent"
                        : "border-border bg-surface text-muted hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    #{tag}
                    <span className="tabular text-muted-strong">{formatCompact(count)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Feed */}
      {sorted.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare size={24} />}
          title="No comments match these filters"
          detail="Try widening the platform, sentiment, or tag selection — or clear everything to see the full feed."
          action={
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg border border-border bg-surface-raised px-4 py-2 text-xs font-medium transition-colors hover:border-border-strong hover:bg-surface-hover"
            >
              Clear filters
            </button>
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {visible.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                selectedTags={selectedTags}
                onTagClick={toggleTag}
              />
            ))}
          </div>
          <div className="mt-5 flex flex-col items-center gap-2">
            <div className="text-[11px] text-muted-strong">
              Showing {formatNumber(Math.min(visibleCount, sorted.length))} of{" "}
              {formatNumber(sorted.length)} comments
            </div>
            {sorted.length > visibleCount && (
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                className="rounded-lg border border-border bg-surface-raised px-4 py-2 text-xs font-medium transition-colors hover:border-border-strong hover:bg-surface-hover"
              >
                Show more
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryChip({
  label,
  count,
  dotClass,
  textClass,
  active,
  onClick,
}: {
  label: string;
  count: number;
  dotClass: string;
  textClass: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? "Clear this filter" : `Filter feed: ${label}`}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
        active
          ? "border-border-strong bg-surface-hover"
          : "border-border bg-surface hover:bg-surface-hover",
        textClass,
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", dotClass)} aria-hidden />
      <span className="tabular">{formatNumber(count)}</span>
      {label}
    </button>
  );
}

function CommentCard({
  comment: c,
  selectedTags,
  onTagClick,
}: {
  comment: FeedComment;
  selectedTags: string[];
  onTagClick: (tag: string) => void;
}) {
  const videoLabel = c.video
    ? truncate(c.video.title ?? c.video.caption ?? c.video.originalUrl, 72)
    : null;
  const hasMetaRow =
    c.likes !== null || c.replyCount !== null || c.tags.length > 0 || c.episodeName !== null;

  return (
    <Card
      className={clsx(
        "px-4 py-3.5",
        c.needsResponse && "border-l-2 border-l-warning/70 bg-[rgba(251,191,36,0.03)]",
        !c.needsResponse && c.sentiment === "question" && "border-l-2 border-l-accent/60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <PlatformDot platform={c.platform} />
          <span className="text-sm font-medium">{c.authorName ?? "Unknown"}</span>
          <span className="text-[11px] text-muted-strong">
            {c.postedAt ? (
              <TimeAgo iso={c.postedAt} />
            ) : (
              <>
                <TimeAgo iso={c.capturedAt} /> (captured)
              </>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {c.sentiment && (
            <span
              className={clsx(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold",
                SENTIMENT_CHIP[c.sentiment],
              )}
            >
              {SENTIMENT_LABEL[c.sentiment]}
            </span>
          )}
          {c.needsResponse && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[rgba(251,191,36,0.1)] px-2 py-0.5 text-[10px] font-semibold text-warning">
              <Reply size={10} aria-hidden />
              Needs response
            </span>
          )}
          {c.permalink && (
            <a
              href={c.permalink}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open comment on platform"
              title="Open comment on platform"
              className="rounded p-1 text-muted-strong transition-colors hover:text-foreground"
            >
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </div>

      <p className="mt-2 break-words text-sm leading-relaxed text-foreground/90">{c.text}</p>

      {hasMetaRow && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted">
          {c.likes !== null && (
            <span className="tabular inline-flex items-center gap-1" title="Likes">
              <Heart size={11} aria-hidden />
              {formatCompact(c.likes)}
            </span>
          )}
          {c.replyCount !== null && (
            <span className="tabular inline-flex items-center gap-1" title="Replies">
              <MessageCircle size={11} aria-hidden />
              {formatCompact(c.replyCount)} {c.replyCount === 1 ? "reply" : "replies"}
            </span>
          )}
          {c.episodeName && (
            <span className="inline-flex items-center gap-1 text-muted-strong" title="Episode">
              <Layers size={11} aria-hidden />
              {c.episodeName}
            </span>
          )}
          {c.tags.map((tag) => {
            const selected = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                aria-pressed={selected}
                title={selected ? `Stop filtering by “${tag}”` : `Filter by tag “${tag}”`}
                className={clsx(
                  "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  selected
                    ? "border-accent bg-[rgba(59,130,246,0.1)] text-accent"
                    : "border-border bg-surface text-muted-strong hover:text-muted",
                )}
              >
                #{tag}
              </button>
            );
          })}
        </div>
      )}

      {c.video && (
        <a
          href={c.video.originalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group mt-3 flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 transition-colors hover:border-border-strong hover:bg-surface-hover"
        >
          <VideoThumb src={c.video.thumbnailUrl} platform={c.platform} className="h-10 w-7" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted transition-colors group-hover:text-foreground">
            {videoLabel}
          </span>
          <span className="hidden sm:inline-flex">
            <PlatformBadge platform={c.platform} size="sm" />
          </span>
          <ExternalLink size={12} className="shrink-0 text-muted-strong" aria-hidden />
        </a>
      )}
    </Card>
  );
}
