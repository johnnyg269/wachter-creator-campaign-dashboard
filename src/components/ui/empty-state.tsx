import { Card } from "./card";
import { TextReveal } from "./text-reveal";

/** Polished empty/error state — used instead of blank charts or zero-rows.
 *  Title + detail enter with the transitions.dev "Texts reveal" stagger. */
export function EmptyState({
  title,
  detail,
  action,
  icon,
}: {
  title: string;
  detail?: string | null;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      {icon && <div className="text-muted-strong">{icon}</div>}
      <TextReveal>
        <div className="t-stagger-line t-stagger-line--1 text-sm font-medium text-muted">{title}</div>
        {detail && (
          <div className="t-stagger-line t-stagger-line--2 mx-auto max-w-md text-xs text-muted-strong">{detail}</div>
        )}
      </TextReveal>
      {action && <div className="mt-2">{action}</div>}
    </Card>
  );
}
