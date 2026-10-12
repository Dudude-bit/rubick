import type { EndedRun, Evidence, PodCause } from "@/generated/types";
import type { T } from "@/i18n/useT";
import { formatDuration } from "@/lib/utils";

/**
 * Why a pod is red or amber, in the words every surface that draws it says.
 *
 * The cause itself is decided once, in Rust (`pod_cause`), from the pod's
 * own status; this only phrases it, with whatever evidence the surface read
 * beside it. A sentence that goes past the evidence says so.
 */

export type CauseTone = "err" | "warn";

export interface CauseWords {
  /** What happened, and how long it took, as one sentence. */
  sentence: string;
  /** The app's or the cluster's own words, quoted, and what they are. */
  quote: { label: string; text: string } | null;
  /** What could not be read, said as such. */
  note: string | null;
  tone: CauseTone;
}

/** A cause still true at `now`: an exit a container has been up since stops counting at its `until`. */
export function currentCause(
  cause: PodCause | null | undefined,
  now: number = Date.now()
): PodCause | null {
  if (!cause) return null;
  if (cause.until && Date.parse(cause.until) <= now) return null;
  return cause;
}

/** How long a run lasted, where the kubelet stamped both ends. */
export function ranSeconds(run: EndedRun): number | null {
  if (!run.started || !run.ended) return null;
  const ran = (Date.parse(run.ended) - Date.parse(run.started)) / 1000;
  return Number.isFinite(ran) && ran >= 0 ? ran : null;
}

const ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`,
  "g"
);

/** Lines that carry no reason of their own: frames, the runtime's sign-off, a wrapper's exit note. */
const NOT_TELLING =
  /^(goroutine \d+|Node\.js v\d|exit status \d+$|\.\.\. \d+ more|[\w.$/*<>-]+\([^)]*\)$)/;

/**
 * The line of a run's last words that says why: the last one that is not a
 * stack frame or a sign-off, and whether it is also the very last line.
 */
export function tellingLine(
  text: string
): { text: string; last: boolean } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(ESCAPE, "").trimEnd())
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) return null;
  const end = lines.length - 1;
  for (let at = end; at >= 0; at -= 1) {
    const line = lines[at];
    if (!/^\s/.test(line) && !NOT_TELLING.test(line.trim()))
      return { text: line.trim(), last: at === end };
  }
  return { text: lines[end].trim(), last: true };
}

function howItEnded(run: EndedRun): string {
  const code =
    run.signal !== null ? `signal ${run.signal}` : `exit ${run.code}`;
  return run.reason ? `${code}, ${run.reason}` : code;
}

function logNote(log: Evidence, t: T): string | null {
  switch (log.says) {
    case "reading":
      return t("readings", "failedRunLogAsking");
    case "nothing":
      return t("readings", "failedRunLogEmpty");
    case "gone":
      return t("readings", "failedRunLogGone");
    case "refused":
      return t("cause", "logRefused");
    case "failed":
      return t("cause", "logFailed", { said: log.said });
    case "line":
    case "event":
    case "notRead":
      return null;
  }
}

function quoteOf(run: EndedRun, t: T): CauseWords["quote"] {
  const said = run.said ? tellingLine(run.said) : null;
  if (said) return { label: t("cause", "exitMessage"), text: said.text };
  if (run.log.says !== "line") return null;
  return {
    label: t("cause", run.log.last ? "lastLine" : "loggedLine"),
    text: run.log.text,
  };
}

/** The cause in words. */
export function causeWords(cause: PodCause, t: T): CauseWords {
  const { container, run } = cause;
  if (!run)
    return {
      sentence: t("cause", "restartedUnreported", { container }),
      quote: null,
      note: null,
      tone: "warn",
    };
  const ran = ranSeconds(run);
  const head = t("cause", "exited", { container, how: howItEnded(run) });
  return {
    sentence:
      ran === null
        ? head
        : `${head}, ${t("cause", "ranFor", { ran: formatDuration(ran) })}`,
    quote: quoteOf(run, t),
    note: run.said ? null : logNote(run.log, t),
    tone: "err",
  };
}

/** The evidence after the sentence, as plain text. */
export function evidenceText(words: CauseWords): string {
  return [words.quote && `${words.quote.label} ${words.quote.text}`, words.note]
    .filter(Boolean)
    .join(" ");
}

/** The cause as plain text: a tooltip, a row's hover, a line in a shared file. */
export function causeText(cause: PodCause, t: T): string {
  const words = causeWords(cause, t);
  return [`${words.sentence}.`, evidenceText(words)].filter(Boolean).join(" ");
}
