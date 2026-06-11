"use client";

// Relative timestamps that self-update. suppressHydrationWarning because the
// server-rendered value can differ by a minute from the client's first paint.

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/format";

export function TimeAgo({ iso }: { iso: string | null | undefined }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  return (
    <time dateTime={iso ?? undefined} suppressHydrationWarning title={iso ?? undefined}>
      {timeAgo(iso)}
    </time>
  );
}
