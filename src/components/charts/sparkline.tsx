// Tiny inline sparkline for per-video view trend. Pure SVG (no chart library)
// — cheap to render in long lists. Plots ONLY the real confirmed-view points
// it is given (see viewSparkline in lib/range.ts); never interpolates or
// invents data. Renders nothing when there aren't enough real points.

import { useId } from "react";
import clsx from "clsx";

export function Sparkline({
  points,
  color = "#60a5fa",
  width = 96,
  height = 28,
  className,
  ariaLabel,
}: {
  points: number[] | null;
  color?: string;
  width?: number;
  height?: number;
  className?: string;
  ariaLabel?: string;
}) {
  // Document-global SVG id, unique per component instance (colons stripped so
  // it stays valid inside url(#…)). Prevents gradient-fill collisions when
  // many sparklines render on one page.
  const gradId = `spark-${useId().replace(/:/g, "")}`;
  if (!points || points.length < 3) {
    return (
      <span
        className={clsx("inline-block text-[10px] text-muted-strong", className)}
        style={{ width, height, lineHeight: `${height}px` }}
      >
        building…
      </span>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const stepX = w / (points.length - 1);
  const coords = points.map((v, i) => {
    const x = pad + i * stepX;
    // Invert Y (SVG origin top-left); flat series sits on the baseline.
    const y = pad + h - ((v - min) / span) * h;
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${height - pad} L${coords[0][0].toFixed(1)},${height - pad} Z`;
  const last = coords[coords.length - 1];
  const climbing = points[points.length - 1] >= points[0];
  const stroke = color;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={clsx("overflow-visible", className)}
      role="img"
      aria-label={ariaLabel ?? `View trend, ${climbing ? "climbing" : "flat or declining"}`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} stroke="none" />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2} fill={stroke} />
    </svg>
  );
}
