import type { ShellEnvReport } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";

/**
 * Whether the search path was built from a real answer.
 *
 * The twin of `ShellEnvReport::answered()` in Rust, and the one place the
 * frontend asks. Everything that reports an absence — a plugin, a tool, a
 * binary a context names — rests on that path, and an absence verdict from a
 * list nobody filled in is a guess wearing a fact's clothes.
 */
export function shellAnswered(report: ShellEnvReport): boolean {
  return report.outcome === "imported" || report.outcome === "notAsked";
}

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
    // Not a shell that failed — a build that never asked one. Its own
    // sentence, because `notAsked` says the path is right and this says
    // nobody knows.
    case "notRecorded":
      return t("settings", "shellEnvNotRecorded");
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
  // A guess, like the failures above: nothing filled the path in.
  notRecorded: "text-warn",
};

export function shellEnvTone(report: ShellEnvReport): string {
  return TONES[report.outcome];
}

/**
 * The same sentence in English, for the pasted report. One catalogue entry
 * per outcome, not a second hand-written copy that drifts from the screen.
 */
/**
 * The catalogue in English, for the pasted report.
 *
 * Exported because the report needs it for anything that also appears on
 * screen: a sentence written twice — once for the pane, once for the paste —
 * is two places to fix a wording, and the halves disagree the first time
 * somebody fixes one. Prose that exists only in the report has no catalogue
 * key and stays inline there.
 */
export const english: T = (section, key, values) =>
  translate("en", section, key, values);

export function shellEnvLine(report: ShellEnvReport): string {
  return shellEnvSentence(report, english);
}
