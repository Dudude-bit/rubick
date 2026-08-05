/**
 * StatusBadge - status indicator for Kubernetes resources.
 *
 * Colour is derived from a semantic role, never written per status. The
 * label is always present: colour reinforces meaning, it never carries
 * it alone.
 *
 * Not a pill. A filled chip is a container, and the design removed those
 * everywhere else; worse, it spent colour on the healthy majority, so a
 * column of twenty Running rows shouted exactly as loudly as the one row
 * that had crashed. `ok` is therefore plain text — the anomaly is the only
 * thing worth a hue, and it now has the column to itself.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { statusRole, type StatusRole } from "@/lib/status-role";

const ROLE_CLASS: Record<StatusRole, string> = {
  ok: "text-fg-mid",
  pending: "text-info",
  warn: "text-warn",
  err: "text-err",
  neutral: "text-fg-mut",
};

const DOT_CLASS: Record<StatusRole, string> = {
  ok: "bg-ok",
  pending: "bg-info",
  warn: "bg-warn",
  err: "bg-err",
  neutral: "bg-fg-fnt",
};

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Raw status from the API, e.g. "Running", "CrashLoopBackOff". */
  status: string;
  /** Show a leading dot in the role colour. */
  showDot?: boolean;
  /**
   * Override the derived role when the caller knows better. Not named
   * `role` — that collides with the ARIA `role` attribute inherited from
   * `React.HTMLAttributes`, which is a type error, not a style choice.
   */
  roleOverride?: StatusRole;
}

export function StatusBadge({
  status,
  showDot = false,
  roleOverride,
  className,
  children,
  ...props
}: StatusBadgeProps) {
  const resolved = roleOverride ?? statusRole(status);
  return (
    <span
      className={cn(
        // Mono, because a status column is a set of fixed tokens read down
        // the page rather than prose read across it, and the same glyph
        // width is what makes it scannable now the chip is gone. 16px line
        // box with no vertical padding: the status must never be what
        // decides how tall a table row is.
        "inline-flex items-center gap-1.5 font-mono text-[11px] font-medium leading-4",
        ROLE_CLASS[resolved],
        className
      )}
      {...props}
    >
      {showDot && (
        <span className={cn("h-1.5 w-1.5 rounded-full", DOT_CLASS[resolved])} />
      )}
      {children ?? status}
    </span>
  );
}

export interface ConditionBadgeProps extends Omit<StatusBadgeProps, "status"> {
  /** Condition status: "True", "False" or "Unknown". */
  conditionStatus: string;
  /** Condition type, e.g. "Ready". */
  conditionType?: string;
}

export function ConditionBadge({
  conditionStatus,
  conditionType,
  children,
  ...props
}: ConditionBadgeProps) {
  return (
    <StatusBadge status={conditionStatus} {...props}>
      {children ?? conditionType ?? conditionStatus}
    </StatusBadge>
  );
}
