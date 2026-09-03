import type { ShellEnvReport } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/** The one sentence about where the search path came from. */
export function shellEnvSentence(report: ShellEnvReport, t: T): string {
  switch (report.outcome) {
    case "imported":
      return t("settings", "shellEnvImported", {
        shell: report.shell,
        n: report.adopted,
        removed: report.removed,
      });
    case "timedOut":
      return t("settings", "shellEnvTimedOut", {
        shell: report.shell,
        seconds: report.seconds,
      });
    case "couldNotStart":
      return t("settings", "shellEnvCouldNotStart", {
        shell: report.shell,
        error: report.error,
      });
    case "noAnswer":
      // A shell killed by a signal has no exit code; "?" is honest and
      // reads as such beside a number.
      return t("settings", "shellEnvNoAnswer", {
        shell: report.shell,
        exit: report.exit ?? "?",
      });
    case "notAsked":
      return t("settings", "shellEnvNotAsked");
  }
}

/**
 * How loudly the sentence is drawn. Total, so an outcome the backend learns
 * to report has to be given a tone here. Every outcome that leaves the
 * search path a guess is a warning, because the directories listed under it
 * are then the wrong thing to check.
 */
const TONES: Record<ShellEnvReport["outcome"], "text-fg-mut" | "text-warn"> = {
  imported: "text-fg-mut",
  timedOut: "text-warn",
  couldNotStart: "text-warn",
  noAnswer: "text-warn",
  notAsked: "text-fg-mut",
};

export function shellEnvTone(report: ShellEnvReport): string {
  return TONES[report.outcome];
}

/**
 * The same sentence in English, for the pasted report. One catalogue entry
 * per outcome, not a second hand-written copy that drifts from the screen.
 */
const english: T = (section, key, values) =>
  translate("en", section, key, values);

export function shellEnvLine(report: ShellEnvReport): string {
  return shellEnvSentence(report, english);
}
