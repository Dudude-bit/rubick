import { EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
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

/** How long a verdict that arrived on this page stays in the header row before it takes its own line. */
const SETTLE_MS = 1000;

/**
 * Whether `key` has stood for `ms`, or stood already when the page opened: a
 * drain's 0.3 s of Unavailable came and went as a line that pushed the page
 * down and back.
 */
function useStood(key: string | null, ms: number): boolean {
  const [held, setHeld] = useState({ key, stood: true });
  if (held.key !== key) setHeld({ key, stood: false });
  const pending = held.key === key && !held.stood && key !== null;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(
      () => setHeld((now) => (now.key === key ? { key, stood: true } : now)),
      ms
    );
    return () => clearTimeout(timer);
  }, [pending, key, ms]);
  return held.key === key && held.stood;
}

/**
 * The rollout verdict in a sentence, with the controller's own words after it.
 * The page header and the peek draw this one line, so the two cannot disagree.
 *
 * A page puts a passing state in its header row (`header`) and the rest
 * above the strip (`line`), so what is under them does not move on a drain;
 * a verdict that arrives while the page is open waits in the header row
 * until it has lasted.
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
  const stood = useStood(
    place && line && !passing(line) ? rollout.state : null,
    SETTLE_MS
  );
  if (!line) return null;
  const Icon = TONE_ICON[line.tone];
  const header = passing(line) || !stood;
  if (place === "line" && header) return null;
  if (place === "header")
    return header ? (
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
