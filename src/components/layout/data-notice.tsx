// Global data-provenance banners: demo mode and ephemeral storage warnings.
// Rendered at the top of data pages so nobody can mistake demo/ephemeral
// numbers for live campaign data.

import { AlertTriangle, FlaskConical } from "lucide-react";
import type { HealthSummary } from "@/lib/queries";

export function DataNotice({ health }: { health: HealthSummary }) {
  return (
    <>
      {health.mockMode && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warning/40 bg-[rgba(251,191,36,0.08)] px-4 py-2.5 text-xs text-warning">
          <FlaskConical size={14} />
          <span>
            <strong>Demo data mode</strong> — MOCK_DATA=1 is set. Numbers below are generated for
            local development and are not real campaign data.
          </span>
        </div>
      )}
      {!health.mockMode && health.store.ephemeral && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warning/40 bg-[rgba(251,191,36,0.08)] px-4 py-2.5 text-xs text-warning">
          <AlertTriangle size={14} />
          <span>
            <strong>Ephemeral storage</strong> — no DATABASE_URL configured, so snapshots reset
            between deployments/invocations. Connect Supabase Postgres for durable history.
          </span>
        </div>
      )}
    </>
  );
}
