"use client";

// Campaign settings: name/creator/company display, editable start date, and
// storage-mode info.

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Campaign } from "@/lib/types";
import type { StoreInfo } from "@/lib/store/types";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { formatDate } from "@/lib/format";
import { Database } from "lucide-react";

export function CampaignSettings({
  campaign,
  storeInfo,
}: {
  campaign: Campaign;
  storeInfo: StoreInfo;
}) {
  const router = useRouter();
  const [startDate, setStartDate] = useState(campaign.startDate?.slice(0, 10) ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function saveStartDate() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/campaign", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: startDate || null }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      setMessage(data.ok ? "Saved" : (data.error ?? "Save failed"));
      if (data.ok) router.refresh();
    } catch {
      setMessage("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Campaign" subtitle="Videos published at/after the start date are tracked" />
      <CardBody className="space-y-4 text-xs">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <div className="text-muted-strong">Name</div>
            <div className="mt-0.5 font-medium">{campaign.name}</div>
          </div>
          <div>
            <div className="text-muted-strong">Creator</div>
            <div className="mt-0.5 font-medium">{campaign.creatorName}</div>
          </div>
          <div>
            <div className="text-muted-strong">Company</div>
            <div className="mt-0.5 font-medium">{campaign.company}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="mb-1 block text-muted" htmlFor="campaign-start">
              Campaign start date{" "}
              <span className="text-muted-strong">
                (currently {campaign.startDate ? formatDate(campaign.startDate) : "auto — pending first refresh"})
              </span>
            </label>
            <input
              id="campaign-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 outline-none focus:border-accent"
            />
          </div>
          <button
            onClick={saveStartDate}
            disabled={busy}
            className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 font-medium hover:bg-surface-hover disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {message && <span className="pb-1.5 text-muted">{message}</span>}
        </div>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-muted">
          <Database size={13} />
          <span>
            Storage: <strong className="text-foreground">{storeInfo.kind}</strong> — {storeInfo.detail}
          </span>
        </div>
      </CardBody>
    </Card>
  );
}
