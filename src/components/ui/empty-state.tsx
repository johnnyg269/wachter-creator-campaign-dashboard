import { Card } from "./card";

/** Polished empty/error state — used instead of blank charts or zero-rows. */
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
      <div className="text-sm font-medium text-muted">{title}</div>
      {detail && <div className="max-w-md text-xs text-muted-strong">{detail}</div>}
      {action && <div className="mt-2">{action}</div>}
    </Card>
  );
}
