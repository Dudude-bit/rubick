import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Eye, Pencil, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface QuickAction<T> {
  /** Icon to display */
  icon: LucideIcon;
  /** Tooltip label */
  label: string;
  /** Click handler */
  onClick: (item: T) => void;
  /** Button variant */
  variant?: "default" | "destructive" | "ghost";
  /** Condition to hide action */
  hidden?: (item: T) => boolean;
  /** Condition to disable action */
  disabled?: (item: T) => boolean;
}

interface QuickActionsProps<T> {
  /** Item data */
  item: T;
  /** List of quick actions */
  actions: QuickAction<T>[];
  /** Additional class names */
  className?: string;
}

/**
 * The actions at the end of a row.
 *
 * Shown on hover and on keyboard focus, and *in CSS* rather than in React
 * state. The row is the `group`; a state-driven version re-rendered every
 * cell in the table each time the pointer crossed a row boundary, which on a
 * list that re-reads itself every two seconds is a layout recomputed under
 * the pointer.
 */
const ROW_ACTIONS_REVEAL =
  "opacity-0 pointer-events-none transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-data-[focused=true]:pointer-events-auto group-data-[focused=true]:opacity-100";

export function QuickActions<T>({
  item,
  actions,
  className,
}: QuickActionsProps<T>) {
  const visibleActions = actions.filter((action) => !action.hidden?.(item));

  if (visibleActions.length === 0) return null;

  return (
    <div
      className={cn("flex items-center gap-0.5", ROW_ACTIONS_REVEAL, className)}
      onClick={(e) => e.stopPropagation()}
    >
      {visibleActions.map((action) => {
        const isDisabled = action.disabled?.(item);
        const Icon = action.icon;

        return (
          <Tooltip key={action.label}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  // The row's height is whatever the tallest cell is, and
                  // an icon button is usually it. The visual target is 20px
                  // so it fits a compact row's line box; the pseudo-element
                  // pushes the pointer target back out to 24px, because a
                  // 20px click target is hostile even when it looks tidy.
                  "relative h-5 w-5 before:absolute before:-inset-0.5 before:content-['']",
                  action.variant === "destructive" &&
                    "text-err hover:bg-err/16 hover:text-err"
                )}
                aria-label={action.label}
                disabled={isDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick(item);
                }}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {action.label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

// Helper to create common quick actions.
// Co-locating these factories with the component breaks fast-refresh
// in dev (each save remounts the whole module). The trade-off favours
// callsite ergonomics — splitting into quick-actions-factories.ts
// would mean two imports for every consumer page.
/* eslint-disable react-refresh/only-export-components */
export function createViewAction<T>(
  onClick: (item: T) => void,
  icon?: LucideIcon
): QuickAction<T> {
  return {
    icon: icon ?? Eye,
    label: "View Details",
    onClick,
  };
}

export function createDeleteAction<T>(
  onClick: (item: T) => void
): QuickAction<T> {
  return {
    icon: Trash2,
    label: "Delete",
    onClick,
    variant: "destructive",
  };
}

export function createEditAction<T>(
  onClick: (item: T) => void
): QuickAction<T> {
  return {
    icon: Pencil,
    label: "Edit",
    onClick,
  };
}
/* eslint-enable react-refresh/only-export-components */
