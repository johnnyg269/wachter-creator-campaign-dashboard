"use client";

// Generic horizontal/vertical bar chart for platform & episode comparisons.

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompact, formatPct } from "@/lib/format";

export interface BarDatum {
  name: string;
  value: number | null;
  color?: string;
}

export function SimpleBarChart({
  data,
  height = 240,
  layout = "vertical",
  valueKind = "number",
}: {
  data: BarDatum[];
  height?: number;
  layout?: "vertical" | "horizontal";
  valueKind?: "number" | "percent";
}) {
  const fmt = (v: number) => (valueKind === "percent" ? formatPct(v) : formatCompact(v));
  const rows = data.map((d) => ({ ...d, value: d.value ?? 0, unavailable: d.value === null }));
  const vertical = layout === "vertical";
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={rows}
        layout={vertical ? "vertical" : "horizontal"}
        margin={{ top: 4, right: 12, bottom: 0, left: vertical ? 8 : 0 }}
      >
        <CartesianGrid stroke="#1c2433" strokeDasharray="3 3" horizontal={!vertical} vertical={vertical} />
        {vertical ? (
          <>
            <XAxis
              type="number"
              stroke="#5c6878"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => fmt(v)}
            />
            <YAxis
              type="category"
              dataKey="name"
              stroke="#8b97a8"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={110}
            />
          </>
        ) : (
          <>
            <XAxis
              dataKey="name"
              stroke="#8b97a8"
              fontSize={11}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              stroke="#5c6878"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              width={44}
              tickFormatter={(v: number) => fmt(v)}
            />
          </>
        )}
        <Tooltip
          cursor={{ fill: "rgba(59,130,246,0.06)" }}
          contentStyle={{
            background: "#11161f",
            border: "1px solid #2a3447",
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(value, _name, item) => {
            const payload = (item as { payload?: { unavailable?: boolean } } | undefined)?.payload;
            if (payload?.unavailable) return ["Unavailable", ""];
            return [fmt(Number(value ?? 0)), ""];
          }}
        />
        <Bar dataKey="value" radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={28}>
          {rows.map((d, i) => (
            <Cell key={i} fill={d.unavailable ? "#2a3447" : (d.color ?? "#3b82f6")} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
