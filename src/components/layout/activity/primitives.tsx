import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The activity tabs live inside the panel, not on top of it, so they get
 * the canvas treatment: no cards around rows, one hairline between them,
 * 12px text with the secondary line a step down in contrast.
 */
export const ACTIVITY_ROW =
  "flex items-center gap-2.5 border-b border-hair px-3 py-1.5 text-xs";

export function ActivityGroup({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-baseline gap-2 px-3 pb-1 pt-3 text-[11px] text-fg-fnt">
        <span>{title}</span>
        {count != null && <span>{count}</span>}
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </section>
  );
}

export function ActivityEmpty({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
      <Icon className="h-5 w-5 text-fg-fnt" />
      <p className="text-xs text-fg-mut">{title}</p>
      {hint && <p className="text-[11px] text-fg-fnt">{hint}</p>}
    </div>
  );
}

export function ActivityAction({
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-fg-mut transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
