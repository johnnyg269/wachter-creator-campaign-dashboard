"use client";

// Views/engagements trend line. Gaps (null) stay gaps — no fake zeros.

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint } from "@/lib/metrics";
import { formatCompact, formatDateTime } from "@/lib/format";

export function TrendChart({
  data,
  showEngagements = false,
  height = 280,
}: {
  data: TrendPoint[];
  showEngagements?: boolean;
  height?: number;
}) {
  const points = data.map((p) => ({ ...p, label: formatDateTime(p.t) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="viewsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="engFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity={0.2} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#1c2433" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          stroke="#5c6878"
          fontSize={10}
          tickLine={false}
          axisLine={false}
          minTickGap={48}
        />
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
            String(name) === "views" ? "Views" : "Engagements",
          ]}
        />
        <Area
          type="monotone"
          dataKey="views"
          stroke="#3b82f6"
          strokeWidth={2}
          fill="url(#viewsFill)"
          connectNulls={false}
          dot={false}
        />
        {showEngagements && (
          <Area
            type="monotone"
            dataKey="engagements"
            stroke="#34d399"
            strokeWidth={1.5}
            fill="url(#engFill)"
            connectNulls={false}
            dot={false}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}
