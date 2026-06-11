"use client";

// Per-platform views-over-time comparison (one line per platform).

import {
  CartesianGrid,
  Line,
  LineChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Platform } from "@/lib/types";
import { PLATFORM_LABELS } from "@/lib/types";
import type { TrendPoint } from "@/lib/metrics";
import { formatCompact, formatDateTime } from "@/lib/format";
import { PLATFORM_HEX } from "@/components/ui/platform";

export function MultiTrendChart({
  trendByPlatform,
  height = 300,
}: {
  trendByPlatform: Partial<Record<Platform, TrendPoint[]>>;
  height?: number;
}) {
  const platforms = (Object.keys(trendByPlatform) as Platform[]).filter(
    (p) => (trendByPlatform[p] ?? []).length > 0,
  );
  const base = trendByPlatform[platforms[0]] ?? [];
  const rows = base.map((point, i) => {
    const row: Record<string, string | number | null> = { label: formatDateTime(point.t) };
    for (const p of platforms) {
      row[p] = trendByPlatform[p]?.[i]?.views ?? null;
    }
    return row;
  });
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#1c2433" strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" stroke="#5c6878" fontSize={10} tickLine={false} axisLine={false} minTickGap={48} />
        <YAxis
          stroke="#5c6878"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v: number) => formatCompact(v)}
        />
        <Tooltip
          contentStyle={{
            background: "#11161f",
            border: "1px solid #2a3447",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "#8b97a8" }}
          formatter={(value, name) => [
            formatCompact(Number(value ?? 0)),
            PLATFORM_LABELS[String(name) as Platform] ?? String(name),
          ]}
        />
        <Legend
          formatter={(value: string) => (
            <span style={{ color: "#8b97a8", fontSize: 11 }}>
              {PLATFORM_LABELS[value as Platform] ?? value}
            </span>
          )}
        />
        {platforms.map((p) => (
          <Line
            key={p}
            type="monotone"
            dataKey={p}
            stroke={PLATFORM_HEX[p]}
            strokeWidth={2}
            connectNulls={false}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
