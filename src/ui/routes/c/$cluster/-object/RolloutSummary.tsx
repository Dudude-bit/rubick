import { EyeOff } from "lucide-react";
import { ResourceMessage } from "@/components/object/ResourceMessage";
import { StatusBadge } from "@/components/ui/status-badge";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { ROLE_ICON } from "@/lib/status-role";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { rolloutLine, type RolloutLine } from "@/lib/workload-status";
import { rolloutBadge } from "./rollout-badge";
import type { MessageSubject } from "@/lib/message-refs";
import type { Rollout } from "@/generated/types";

const TONE_ICON: Record<RolloutLine["tone"], (typeof ROLE_ICON)["ok"]> = {
  err: ROLE_ICON.err,
  warn: ROLE_ICON.warn,
  info: ROLE_ICON.pending,
  unknown: EyeOff,
};

/** A state a rollout passes through on every drain, restart or scale, with nothing of the controller's to quote. */
const passing = (line: RolloutLine) => line.tone === "info" && !line.said;

/**
 * The rollout verdict in a sentence, with the controller's own words after it.
 * The page header and the peek draw this one line, so the two cannot disagree.
 *
 * A page puts a passing state in its header row (`header`) and the rest
 * above the strip (`line`), so what is under them does not move on a drain.
 */
export function RolloutSummary({
  rollout,
  subject,
  className,
  place,
}: {
  rollout: Rollout;
  subject: MessageSubject;
  className?: string;
  place?: "header" | "line";
}) {
  const t = useT();
  const line = rolloutLine(rollout, t);
  if (!line) return null;
  const Icon = TONE_ICON[line.tone];
  if (place === "line" && passing(line)) return null;
  if (place === "header")
    return passing(line) ? (
      <p
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-[11px]",
          TONE_TEXT[line.tone]
        )}
        data-testid="rollout-summary"
      >
        <Icon className="h-2.5 w-2.5 flex-none" aria-hidden="true" />
        <span className="truncate" title={line.text}>
          {line.text}
        </span>
      </p>
    ) : null;
  return (
    <p
      className={cn(
        "flex items-baseline gap-1.5 text-[11px]",
        TONE_TEXT[line.tone],
        className
      )}
      data-testid="rollout-summary"
    >
      <Icon className="h-2.5 w-2.5 flex-none self-center" aria-hidden="true" />
      <span className="min-w-0 wrap-break-word">
        {line.text}
        {line.said && (
          <span className="text-fg-fnt">
            {" · "}
            {parts(t("readings", "controllerSaid"), {
              said: <ResourceMessage message={line.said} subject={subject} />,
            })}
          </span>
        )}
      </span>
    </p>
  );
}

/** The verdict's word, with its sentence on hover for a surface with no room for it. */
export function RolloutBadge({ rollout }: { rollout: Rollout }) {
  const badge = rolloutBadge(rollout, useT());
  return (
    <StatusBadge
      status={badge.status}
      roleOverride={badge.role}
      glyph={badge.glyph}
      title={badge.title}
    >
      {badge.label}
    </StatusBadge>
  );
}
