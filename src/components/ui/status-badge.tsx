/**
 * StatusBadge - status indicator for Kubernetes resources.
 *
 * Colour is derived from a semantic role, never written per status. The
 * label is always present: colour reinforces meaning, it never carries
 * it alone.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { statusRole, type StatusRole } from "@/lib/status-role";

const ROLE_CLASS: Record<StatusRole, string> = {
  ok: "text-ok bg-ok/[0.16]",
  pending: "text-info bg-info/[0.16]",
  warn: "text-warn bg-warn/[0.16]",
  err: "text-err bg-err/[0.16]",
  neutral: "text-fg-mut bg-hover",
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
        // 16px tall, fixed: the pill is mostly read inside a compact table
        // row, and any padding on top of the line box makes the badge — not
        // the text — decide how tall every row in the table is.
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0 text-[11px] font-medium leading-4",
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
