import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Same geometry as StatusBadge: 16px line box, no vertical padding. The
 * badge is mostly read inside a compact table row, and anything taller
 * than the line box makes the badge — not the row — set the table's pitch.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0 text-[11px] font-medium leading-4 transition-colors",
  {
    variants: {
      variant: {
        default: "bg-sel text-fg",
        secondary: "bg-hover text-fg-mut",
        destructive: "bg-err/[0.16] text-err",
        outline: "border border-hair text-fg-mut",
        success: "bg-ok/[0.16] text-ok",
        warning: "bg-warn/[0.16] text-warn",
        error: "bg-err/[0.16] text-err",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(badgeVariants({ variant }), className)}
        {...props}
      />
    );
  }
);
Badge.displayName = "Badge";

// Co-locating `badgeVariants` with the Badge component breaks
// fast-refresh in dev (each save remounts the whole module).
// Splitting into badge-variants.ts would force every consumer to
// take a second import for marginal HMR gain. Same trade-off
// documented in quick-actions.tsx.
// eslint-disable-next-line react-refresh/only-export-components
export { Badge, badgeVariants };
