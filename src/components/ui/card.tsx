import clsx from "clsx";

export function Card({
  children,
  className,
  hover = true,
}: {
  children: React.ReactNode;
  className?: string;
  /** Subtle border-brighten on hover — keeps the page feeling alive without motion. */
  hover?: boolean;
}) {
  return (
    <div
      className={clsx(
        "card-sheen rounded-xl border border-border",
        hover && "transition-[border-color,box-shadow] duration-200 hover:border-border-strong",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx("flex items-start justify-between gap-3 px-5 pt-4 pb-2", className)}>
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={clsx("px-5 pb-4", className)}>{children}</div>;
}

export function SectionTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={clsx("text-base font-semibold tracking-tight", className)}>{children}</h2>
  );
}
