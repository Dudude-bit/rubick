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
import { useT } from "@/i18n/useT";
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
  /** Off where the caller's own tooltip already carries the word, so two never open at once. */
  wordOnHover?: boolean;
}

export function StatusBadge({
  status,
  showDot = false,
  showIcon = true,
  roleOverride,
  wordOnHover = true,
  className,
  children,
  title,
  ...props
}: StatusBadgeProps) {
  const resolved = roleOverride ?? statusRole(status);
  const Icon = ROLE_ICON[resolved];
  const label = children ?? status;
  // A narrow column cuts the word, so hovering always has it whole.
  const word = typeof label === "string" && label !== "" ? label : null;
  const hover =
    wordOnHover && word && !title?.includes(word)
      ? [word, title].filter(Boolean).join("\n")
      : title;
  return (
    <span
      className={cn(
        // Mono, because a status column is a set of fixed tokens read down
        // the page rather than prose read across it, and the same glyph
        // width is what makes it scannable now the chip is gone. 16px line
        // box with no vertical padding: the status must never be what
        // decides how tall a table row is.
        // A block of its own, not a flex row, so a cut word ends in an
        // ellipsis instead of mid-letter.
        "inline-block max-w-full truncate align-middle font-mono text-[11px] font-medium leading-4",
        ROLE_TEXT[resolved],
        className
      )}
      title={hover}
      {...props}
    >
      {showDot ? (
        <span
          className={cn(
            "mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle",
            ROLE_DOT[resolved]
          )}
        />
      ) : (
        showIcon && (
          <Icon
            className="mr-1 inline-block h-2.5 w-2.5 align-[-1px]"
            aria-hidden="true"
            data-testid="status-badge-icon"
          />
        )
      )}
      {label}
    </span>
  );
}

/**
 * A phase the cluster may not have written yet.
 *
 * Four places draw a volume's phase — two lists and the two detail pages they
 * open — and they used to be handed the word `Unknown`, composed in Rust,
 * because the field was a `String` and something had to go in it. Neither a
 * PersistentVolume nor its claim has an `Unknown` phase, so that word read as
 * one the cluster had chosen, in English, beside phases that really were.
 *
 * Written once because four copies of this decision is how three of them come
 * to say something slightly different a year from now.
 */
export function PhaseBadge({ phase }: { phase: string | null }) {
  const t = useT();
  if (phase) return <StatusBadge status={phase} />;
  // An empty code so the role lookup lands on `neutral` by its own rule
  // rather than by a special case, and the words come from the catalogue.
  return (
    <StatusBadge status="">{t("empty", "nothingReportedYet")}</StatusBadge>
  );
}
