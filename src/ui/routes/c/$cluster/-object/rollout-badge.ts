import { EyeOff } from "lucide-react";

import type { T } from "@/i18n/useT";
import { workloadStatusMeaning } from "@/lib/status-meaning";
import { ownStatusWord } from "@/lib/status-words";
import {
  rolloutLine,
  workloadRole,
  workloadStatus,
} from "@/lib/workload-status";
import type { Rollout } from "@/generated/types";

/** The verdict's badge in parts: the list, the page header and the peek header draw these, so none can disagree. */
export function rolloutBadge(rollout: Rollout, t: T) {
  const line = rolloutLine(rollout, t);
  const status = workloadStatus(rollout);
  return {
    status,
    label: ownStatusWord(status, t),
    role: workloadRole(rollout),
    glyph: rollout.state === "podsUnread" ? EyeOff : undefined,
    title: line
      ? [
          line.text,
          line.said && t("readings", "controllerSaid", { said: line.said }),
        ]
          .filter(Boolean)
          .join(". ")
      : workloadStatusMeaning(status, t),
  };
}
