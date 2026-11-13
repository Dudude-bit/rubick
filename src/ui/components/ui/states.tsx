import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * A read still on its way, said in words beside a spinner. For the line a
 * small panel holds while it waits; a list or a page waits in a skeleton of
 * its own shape instead.
 */
export function Reading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-1.5 text-caption text-fg-fnt",
        className
      )}
    >
      <Spinner size="xs" aria-hidden="true" className="flex-none" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/**
 * A read that answered with nothing: one icon, one sentence, and the next
 * step when there is one. Never for a read that failed; that is `Unknown`.
 */
export function EmptyState({
  icon: Icon = Inbox,
  children,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-empty-state
      className={cn(
        "flex flex-col items-center gap-2 px-3 py-8 text-center",
        className
      )}
    >
      <Icon className="h-5 w-5 text-fg-fnt" aria-hidden="true" />
      <p className="max-w-md text-balance text-xs text-fg-mut">{children}</p>
      {hint && (
        <p className="max-w-md text-balance text-caption text-fg-fnt">{hint}</p>
      )}
      {action}
    </div>
  );
}

/** The small capitals over a group of rows. */
export function Eyebrow({
  children,
  className,
  as: Tag = "p",
}: {
  children: ReactNode;
  className?: string;
  as?: "p" | "h3" | "h4" | "span";
}) {
  return (
    <Tag
      className={cn(
        "text-micro font-semibold uppercase tracking-[0.07em] text-fg-fnt",
        className
      )}
    >
      {children}
    </Tag>
  );
}

export interface Segment<V extends string> {
  value: V;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

/**
 * One of a few views or ranges, side by side. Pressing the chosen one again
 * clears it only where `onClear` says that means something.
 */
export function SegmentedControl<V extends string>({
  value,
  segments,
  onChange,
  onClear,
  label,
  mono = false,
  className,
}: {
  value: V | null;
  segments: readonly Segment<V>[];
  onChange: (value: V) => void;
  onClear?: () => void;
  label: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex items-center gap-0.5", className)}
    >
      {segments.map((segment) => {
        const chosen = segment.value === value;
        return (
          <button
            key={segment.value}
            type="button"
            aria-pressed={chosen}
            disabled={segment.disabled}
            title={segment.title}
            onClick={() => (chosen ? onClear?.() : onChange(segment.value))}
            className={cn(
              "h-6 whitespace-nowrap rounded px-1.5 text-caption transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-info disabled:cursor-default disabled:opacity-40",
              mono && "font-mono",
              chosen
                ? "bg-sel text-fg"
                : "text-fg-mut enabled:hover:bg-hover enabled:hover:text-fg"
            )}
          >
            {segment.label}
          </button>
        );
      })}
    </div>
  );
}
