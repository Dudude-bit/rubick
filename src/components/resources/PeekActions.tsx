import { Copy, ExternalLink, MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { cn } from "@/lib/utils";
import type { PeekTarget } from "@/hooks/usePeek";
import { DetailAction } from "./detail-blocks";
import type { PeekAction, PeekActionId } from "./peek-actions";
import { useObjectActions } from "./useObjectActions";

/**
 * The peek panel's action row.
 *
 * Two rules shape it. Nothing here reimplements a surface a detail page
 * already has — the debug, port-forward, scale and confirm dialogs are the
 * same components, mounted from a drawer instead of a page. And a
 * shell does not open here at all: a terminal in a 440px column is about
 * fifty columns wide, and half the tools anyone opens a shell to run assume
 * eighty. That one leaves for the pod's page, where the terminal is full
 * width and the session shows up in the activity panel like every other one.
 */

export interface PeekActionsProps {
  target: PeekTarget;
  /** The object the panel's own query fetched; undefined until it lands. */
  detail: unknown;
  /** Absent for a kind with no page of its own. */
  onOpenFullPage?: () => void;
  /** Closes the panel. A peek onto a deleted object is a ghost. */
  onClose: () => void;
}

export function PeekActions({
  target,
  detail,
  onOpenFullPage,
  onClose,
}: PeekActionsProps) {
  const copy = useCopyToClipboard();
  const { plan, busy, run, dialogs } = useObjectActions({
    kind: target.kind,
    name: target.name,
    namespace: target.namespace ?? null,
    detail,
    onGone: onClose,
  });

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {onOpenFullPage && (
          <>
            <DetailAction
              label="Open full page"
              icon={ExternalLink}
              onClick={onOpenFullPage}
            />
            <Kbd shortcut="enter" />
          </>
        )}
        <DetailAction
          label="Copy name"
          icon={Copy}
          onClick={() => copy(target.name, `${target.name} copied`)}
        />
        {plan.inline.map((action) => (
          <PeekActionButton
            key={action.id}
            action={action}
            busy={busy[action.id]}
            onRun={() => run(action.id)}
          />
        ))}
        {plan.menu.length > 0 && (
          <PeekActionMenu actions={plan.menu} busy={busy} onRun={run} />
        )}
      </div>
      {dialogs}
    </>
  );
}

function PeekActionButton({
  action,
  busy,
  onRun,
}: {
  action: PeekAction;
  busy?: boolean;
  onRun: () => void;
}) {
  const control = (
    <DetailAction
      label={action.label}
      icon={action.icon}
      onClick={onRun}
      busy={busy}
      danger={action.danger}
      reason={action.reason}
    />
  );
  if (!action.reason) return control;

  return (
    // Faster than the default second: this is not a hint about a control, it
    // is the answer to why the control did nothing.
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent className="max-w-[260px]">{action.reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Where the rare and the destructive go once a kind has more actions than a
 * header row can carry. Delete keeps the error colour it wears on the detail
 * pages — folding it away must not also disguise it.
 */
function PeekActionMenu({
  actions,
  busy,
  onRun,
}: {
  actions: PeekAction[];
  busy: Partial<Record<PeekActionId, boolean>>;
  onRun: (id: PeekActionId) => void;
}) {
  return (
    // Not modal: the panel it sits in is not modal either, and a menu that
    // makes the list behind it inert would undo that.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <DetailAction
          label="More"
          icon={MoreHorizontal}
          onClick={() => {}}
          aria-label="More actions"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={!!action.reason || busy[action.id]}
            onSelect={() => onRun(action.id)}
            className={cn("gap-1.5", action.danger && "text-err")}
          >
            <action.icon className="h-3.5 w-3.5" />
            <span className="flex min-w-0 flex-col">
              {action.label}
              {action.reason && (
                <span className="text-[11px] text-fg-fnt">{action.reason}</span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
