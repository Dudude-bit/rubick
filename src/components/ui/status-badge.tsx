/**
 * StatusBadge - status indicator for Kubernetes resources.
 *
 * Colour is derived from a semantic role, never written per status. The
 * label is always present: colour reinforces meaning, it never carries
 * it alone — and the glyph gives it a third channel, so the column still
 * reads sorted in greyscale.
 *
 * Not a pill. A filled chip is a container, and the design removed those
 * everywhere else. What made the chip shout was its area, not its hue: a
 * ten-pixel glyph spends a fraction of the ink a filled plate does, which
 * is why every role can carry its colour here without the healthy majority
 * drowning the one row that crashed.
 */
import * as React from "react";
import {
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { statusRole, type StatusRole } from "@/lib/status-role";

const ROLE_CLASS: Record<StatusRole, string> = {
  ok: "text-ok",
  pending: "text-info",
  warn: "text-warn",
  err: "text-err",
  neutral: "text-fg-mut",
};

/**
 * Shape, not decoration. Severity has to survive greyscale and the roughly
 * one reader in twelve who cannot separate the red from the green, so the
 * glyphs are chosen to differ in outline: a tick, a clock, a triangle, a
 * cross, a dash.
 */
const ROLE_ICON: Record<StatusRole, LucideIcon> = {
  ok: CircleCheck,
  pending: Clock,
  warn: TriangleAlert,
  err: CircleX,
  neutral: CircleMinus,
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
  /** Show a leading dot in the role colour, instead of the role's glyph. */
  showDot?: boolean;
  /** Off where the surrounding layout already carries a severity mark. */
  showIcon?: boolean;
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
  showIcon = true,
  roleOverride,
  className,
  children,
  ...props
}: StatusBadgeProps) {
  const resolved = roleOverride ?? statusRole(status);
  const Icon = ROLE_ICON[resolved];
  return (
    <span
      className={cn(
        // Mono, because a status column is a set of fixed tokens read down
        // the page rather than prose read across it, and the same glyph
        // width is what makes it scannable now the chip is gone. 16px line
        // box with no vertical padding: the status must never be what
        // decides how tall a table row is.
        "inline-flex items-center gap-1 font-mono text-[11px] font-medium leading-4",
        ROLE_CLASS[resolved],
        className
      )}
      {...props}
    >
      {showDot ? (
        <span
          className={cn(
            "h-1.5 w-1.5 flex-none rounded-full",
            DOT_CLASS[resolved]
          )}
        />
      ) : (
        showIcon && (
          <Icon
            className="h-2.5 w-2.5 flex-none"
            aria-hidden="true"
            data-testid="status-badge-icon"
          />
        )
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
