// Open-alerts preview for the dashboard — up to six rows with a link to the
// full /alerts page.

import Link from "next/link";
import type { Alert } from "@/lib/types";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SeverityBadge } from "@/components/ui/status";
import { PlatformBadge } from "@/components/ui/platform";
import { TimeAgo } from "@/components/ui/time-ago";
import { EmptyState } from "@/components/ui/empty-state";
import { truncate } from "@/lib/format";
import { BellOff } from "lucide-react";

export function AlertsPreview({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) {
    return (
      <EmptyState
        icon={<BellOff size={18} />}
        title="No open alerts"
        detail="Spikes, refresh failures, and comments that need a response will surface here."
        action={
          <Link href="/alerts" className="text-xs font-medium text-accent hover:underline">
            All alerts →
          </Link>
        }
      />
    );
  }
  return (
    <Card>
      <CardHeader
        title="Alerts"
        subtitle={`${alerts.length} open`}
        action={
          <Link
            href="/alerts"
            className="shrink-0 text-xs font-medium text-accent transition-colors hover:underline"
          >
            All alerts →
          </Link>
        }
      />
      <CardBody>
        <ul className="divide-y divide-border">
          {alerts.map((a) => (
            <li key={a.id} className="flex items-start gap-3 py-3">
              <span className="mt-0.5 shrink-0">
                <SeverityBadge severity={a.severity} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{a.title}</span>
                  {a.platform && <PlatformBadge platform={a.platform} size="sm" />}
                </div>
                <p className="mt-0.5 text-xs text-muted">{truncate(a.message, 150)}</p>
              </div>
              <span className="shrink-0 text-[11px] text-muted-strong">
                <TimeAgo iso={a.createdAt} />
              </span>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
