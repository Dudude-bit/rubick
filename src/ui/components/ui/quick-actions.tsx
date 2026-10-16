import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { listWords } from "@/i18n/say";
import { useT } from "@/i18n/useT";
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
  /** Why it cannot run on this item; the button stays, greyed, and says so. */
  reason?: (item: T) => string | undefined;
}

interface QuickActionsProps<T> {
  /** Item data */
  item: T;
  /** List of quick actions */
  actions: QuickAction<T>[];
  /** Additional class names */
  className?: string;
  /** One button in place of the row, opening at this point the menu that holds them all. */
  folded?: (at: { x: number; y: number }) => void;
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
  "opacity-0 pointer-events-none transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-aria-selected:pointer-events-auto group-aria-selected:opacity-100";

/** The same 24px wide target as each button, no taller than the row. */
const TARGET =
  "relative h-5 w-5 before:absolute before:-inset-x-0.5 before:-inset-y-px before:content-['']";

export function QuickActions<T>({
  item,
  actions,
  className,
  folded,
}: QuickActionsProps<T>) {
  const t = useT();
  const visibleActions = actions.filter((action) => !action.hidden?.(item));

  if (visibleActions.length === 0) return null;

  if (folded) {
    const label = t("action", "moreActions");
    return (
      <div
        className={cn("flex items-center", ROW_ACTIONS_REVEAL, className)}
        onClick={(e) => e.stopPropagation()}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={TARGET}
              aria-label={label}
              aria-haspopup="menu"
              onClick={(event) => {
                event.stopPropagation();
                const box = event.currentTarget.getBoundingClientRect();
                folded({ x: box.left, y: box.bottom });
              }}
            >
              <MoreHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[260px] text-xs">
            {t("action", "foldedActions", {
              list: listWords(
                visibleActions.map((action) => action.label),
                t
              ),
            })}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      className={cn("flex items-center gap-0.5", ROW_ACTIONS_REVEAL, className)}
      onClick={(e) => e.stopPropagation()}
    >
      {visibleActions.map((action) => {
        const isDisabled = action.disabled?.(item);
        const reason = action.reason?.(item);
        const Icon = action.icon;

        return (
          <Tooltip key={action.label}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  // A 24px wide target, no taller than the row: a pixel below
                  // the last row made a two-row list scroll.
                  TARGET,
                  action.variant === "destructive" &&
                    "text-err hover:bg-err/16 hover:text-err",
                  reason && "cursor-default opacity-40 hover:bg-transparent"
                )}
                aria-label={action.label}
                aria-disabled={reason ? true : undefined}
                disabled={isDisabled}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!reason) action.onClick(item);
                }}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[260px] text-xs">
              {reason ?? action.label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
