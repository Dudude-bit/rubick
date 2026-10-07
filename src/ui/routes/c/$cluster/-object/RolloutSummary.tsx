import { ResourceMessage } from "@/components/object/ResourceMessage";
import { StatusBadge } from "@/components/ui/status-badge";
import { useT } from "@/i18n/useT";
import { parts } from "@/i18n/parts";
import { ROLE_ICON } from "@/lib/status-role";
import { TONE_TEXT } from "@/lib/tone";
import { cn } from "@/lib/utils";
import { workloadStatusMeaning } from "@/lib/status-meaning";
import { ownStatusWord } from "@/lib/status-words";
import {
  rolloutLine,
  workloadStatus,
  type RolloutLine,
} from "@/lib/workload-status";
import type { MessageSubject } from "@/lib/message-refs";
import type { Rollout } from "@/generated/types";

const TONE_ICON: Record<RolloutLine["tone"], (typeof ROLE_ICON)["ok"]> = {
  err: ROLE_ICON.err,
  warn: ROLE_ICON.warn,
  info: ROLE_ICON.pending,
};

/**
 * The rollout verdict in a sentence, with the controller's own words after it.
 * The page header and the peek draw this one line, so the two cannot disagree.
 */
export function RolloutSummary({
  rollout,
  subject,
  className,
}: {
  rollout: Rollout;
  subject: MessageSubject;
  className?: string;
}) {
  const t = useT();
  const line = rolloutLine(rollout, t);
  if (!line) return null;
  const Icon = TONE_ICON[line.tone];
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
  const t = useT();
  const line = rolloutLine(rollout, t);
  const status = workloadStatus(rollout);
  return (
    <StatusBadge
      status={status}
      title={
        line
          ? [
              line.text,
              line.said && t("readings", "controllerSaid", { said: line.said }),
            ]
              .filter(Boolean)
              .join(". ")
          : workloadStatusMeaning(status, t)
      }
    >
      {ownStatusWord(status, t)}
    </StatusBadge>
  );
}
