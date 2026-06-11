"use client";

import clsx from "clsx";
import { useState } from "react";

export interface TabDef {
  key: string;
  label: string;
  content: React.ReactNode;
}

export function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.key);
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-border" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={t.key === active}
            onClick={() => setActive(t.key)}
            className={clsx(
              "rounded-t-lg px-3 py-2 text-xs font-medium transition-colors -mb-px border-b-2",
              t.key === active
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="pt-4">{current?.content}</div>
    </div>
  );
}
