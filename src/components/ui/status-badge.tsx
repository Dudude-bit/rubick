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
import { cn } from "@/lib/utils";
import {
  ROLE_DOT,
  ROLE_ICON,
  ROLE_TEXT,
  statusRole,
  type StatusRole,
} from "@/lib/status-role";

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /**
   * Raw status from the API, e.g. "Running", "CrashLoopBackOff".
   *
   * A code, never copy. It is what `statusRole` looks up to choose the
   * colour, and that lookup falls back to `neutral` on a miss — so a
   * translated string here would turn every badge grey without failing
   * anything. Put translated text in `children`, which is rendered in
   * preference to this. A lint guard refuses `status={t(...)}`.
   */
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
        ROLE_TEXT[resolved],
        className
      )}
      {...props}
    >
      {showDot ? (
        <span
          className={cn(
            "h-1.5 w-1.5 flex-none rounded-full",
            ROLE_DOT[resolved]
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
