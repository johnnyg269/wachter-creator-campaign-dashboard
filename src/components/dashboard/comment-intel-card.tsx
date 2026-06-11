// Comment intelligence card: totals, sentiment split, top tags, and the
// newest comments — with a link through to the full /comments view.

import Link from "next/link";
import clsx from "clsx";
import type { DashboardData } from "@/lib/queries";
import type { Sentiment } from "@/lib/types";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PlatformDot } from "@/components/ui/platform";
import { TimeAgo } from "@/components/ui/time-ago";
import { formatNumber, truncate } from "@/lib/format";
import { MessageSquare } from "lucide-react";

const SENTIMENT_STYLES: Record<Sentiment, string> = {
  positive: "text-positive bg-[rgba(52,211,153,0.1)]",
  neutral: "text-muted bg-surface border border-border",
  negative: "text-negative bg-[rgba(248,113,113,0.12)]",
  question: "text-accent bg-[rgba(59,130,246,0.1)]",
};

const SENTIMENT_LABELS: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  question: "Question",
};

function SentimentChip({ sentiment }: { sentiment: Sentiment }) {
  return (
    <span
      className={clsx(
        "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
        SENTIMENT_STYLES[sentiment],
      )}
    >
      {SENTIMENT_LABELS[sentiment]}
    </span>
  );
}

function SentimentBar({
  positive,
  neutral,
  negative,
}: {
  positive: number;
  neutral: number;
  negative: number;
}) {
  const total = positive + neutral + negative;
  if (total === 0) {
    return <div className="text-[11px] text-muted-strong">No sentiment data yet</div>;
  }
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  return (
    <div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-surface"
        role="img"
        aria-label={`Sentiment: ${positive} positive, ${neutral} neutral, ${negative} negative`}
      >
        {positive > 0 && <div className="bg-positive" style={{ width: pct(positive) }} />}
        {neutral > 0 && <div className="bg-muted-strong/50" style={{ width: pct(neutral) }} />}
        {negative > 0 && <div className="bg-negative" style={{ width: pct(negative) }} />}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
        <span className="flex items-center gap-1.5 text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-positive" />
          Positive <span className="tabular text-foreground">{formatNumber(positive)}</span>
        </span>
        <span className="flex items-center gap-1.5 text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-strong/50" />
          Neutral <span className="tabular text-foreground">{formatNumber(neutral)}</span>
        </span>
        <span className="flex items-center gap-1.5 text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-negative" />
          Negative <span className="tabular text-foreground">{formatNumber(negative)}</span>
        </span>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: number;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
      <div
        className={clsx(
          "tabular text-lg font-semibold",
          highlight && value > 0 ? "text-warning" : undefined,
        )}
      >
        {formatNumber(value)}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-muted-strong">{label}</div>
    </div>
  );
}

export function CommentIntelCard({
  commentStats,
  recentComments,
}: {
  commentStats: DashboardData["commentStats"];
  recentComments: DashboardData["recentComments"];
}) {
  const newest = [...recentComments]
    .sort((a, b) => (b.postedAt ?? b.capturedAt).localeCompare(a.postedAt ?? a.capturedAt))
    .slice(0, 5);

  return (
    <Card>
      <CardHeader
        title="Comment intelligence"
        subtitle="Audience signal across all platforms"
        action={
          <Link
            href="/comments"
            className="shrink-0 text-xs font-medium text-accent transition-colors hover:underline"
          >
            View all →
          </Link>
        }
      />
      <CardBody>
        {commentStats.total === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <MessageSquare size={18} className="text-muted-strong" />
            <div className="text-sm font-medium text-muted">No comments captured yet</div>
            <div className="max-w-sm text-xs text-muted-strong">
              Comments appear after the first refresh with a comments-capable provider connected.
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <MiniStat label="Total" value={commentStats.total} />
              <MiniStat label="Questions" value={commentStats.questions} />
              <MiniStat label="Mention Wachter" value={commentStats.mentionsWachter} />
              <MiniStat label="Need response" value={commentStats.needsResponse} highlight />
            </div>

            <SentimentBar
              positive={commentStats.positive}
              neutral={commentStats.neutral}
              negative={commentStats.negative}
            />

            {commentStats.topTags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {commentStats.topTags.map((t) => (
                  <span
                    key={t.tag}
                    className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] text-muted"
                  >
                    #{t.tag} <span className="tabular text-muted-strong">{t.count}</span>
                  </span>
                ))}
              </div>
            )}

            <ul className="divide-y divide-border border-t border-border">
              {newest.map((c) => (
                <li key={c.id} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-strong">
                    <PlatformDot platform={c.platform} />
                    <span className="font-medium text-muted">{c.authorName ?? "Unknown"}</span>
                    <TimeAgo iso={c.postedAt ?? c.capturedAt} />
                    {c.sentiment && <SentimentChip sentiment={c.sentiment} />}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-foreground/90">
                    {truncate(c.text, 140)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
