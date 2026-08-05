import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A region on the flat canvas. The replacement for `Card`.
 *
 * Deliberately brings no background, border or shadow: the window is one
 * surface, and stacking tinted boxes on it is what made every screen read
 * as a grid of containers. Grouping is carried by the heading above the
 * content and by the space around it.
 */
export function Section({
  className,
  ...props
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

export interface SectionHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  /** Shown muted beside the title — a row count, a total. */
  count?: React.ReactNode;
  /** One line under the title for a qualifier the title cannot carry. */
  description?: React.ReactNode;
  /** Right-aligned controls belonging to this section. */
  actions?: React.ReactNode;
}

export function SectionHeader({
  title,
  count,
  description,
  actions,
  className,
  ...props
}: SectionHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)} {...props}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold tracking-tight text-fg">
          {title}
        </h2>
        {count != null && <span className="text-xs text-fg-fnt">{count}</span>}
        {actions && (
          <div className="ml-auto flex items-center gap-1">{actions}</div>
        )}
      </div>
      {description && <p className="text-xs text-fg-mut">{description}</p>}
    </div>
  );
}

/** Wrapper for a list or table body: one hairline separates it from the
 *  heading, replacing what used to be the card's top border. */
export function SectionBody({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-t border-hair", className)} {...props} />;
}
