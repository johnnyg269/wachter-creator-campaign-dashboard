// Standard page header used by all routes.

import clsx from "clsx";
import { TextReveal } from "@/components/ui/text-reveal";

export function PageHeader({
  title,
  subtitle,
  actions,
  reveal = false,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  /** Opt-in transitions.dev "Texts reveal" entrance for the title + subtitle. */
  reveal?: boolean;
}) {
  const heading = (
    <>
      <h1 className={clsx("text-xl font-semibold tracking-tight", reveal && "t-stagger-line t-stagger-line--1")}>
        {title}
      </h1>
      {subtitle && (
        <div className={clsx("mt-1 text-xs text-muted", reveal && "t-stagger-line t-stagger-line--2")}>
          {subtitle}
        </div>
      )}
    </>
  );
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>{reveal ? <TextReveal>{heading}</TextReveal> : heading}</div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
