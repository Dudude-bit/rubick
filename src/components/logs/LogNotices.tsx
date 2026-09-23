import type { ReactNode } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { ContainerInfo } from "@/generated/types";
import { Button } from "@/components/ui/button";
import { useNowSeconds } from "@/hooks/useNow";
import {
  describeTermination,
  lastTermination,
  terminationAt,
  terminationWhen,
} from "@/lib/pod-status";

import type { FocusReason } from "./focus";
import type { ContainerFailure } from "./hooks/useLogStream";
import { useT } from "@/i18n/useT";
import type { LostLines } from "./hooks/log-buffer";
import { formatCount, formatSpan, termLabel, type QueryTerm } from "./types";

/**
 * A stream that stopped on its own, said out loud.
 *
 * Above the output rather than replacing it: a pod deleted after an hour
 * of logs still has an hour of logs worth reading. The two kinds read
 * differently on purpose — a deleted pod is a fact and gets no button, a
 * broken connection is a maybe and gets Reconnect.
 */
export function StreamFailureNotice({
  failure,
  podName,
  container: info,
  intake,
  previousRun,
  onRetry,
  onShowCurrentRun,
}: {
  failure: ContainerFailure;
  podName: string;
  /** The container's own status, when the pod object is at hand. */
  container?: ContainerInfo;
  /** Intake is set, so reconnecting will not fetch back the gap. */
  intake: boolean;
  /** The pane is reading the earlier run, so a current one is a way out. */
  previousRun: boolean;
  onRetry: () => void;
  /** The way out of an earlier run that does not exist. */
  onShowCurrentRun: () => void;
}) {
  const t = useT();
  const gone = failure.kind === "gone";
  // A container that has never started has no log, and the apiserver
  // says so in 300 characters of `BadRequest (ErrorResponse { ... })`.
  // The pod's own status has the reason in one word, and a stream that
  // could never have attached is not a stream that was lost.
  const unstarted =
    info !== undefined &&
    info.state.type === "waiting" &&
    info.lastTerminated === null &&
    info.restartCount === 0;
  // Not a failure at all: the container has never restarted, so the
  // previous run that was asked for does not exist. Reconnecting would
  // ask the same unanswerable question again.
  const absent = failure.kind === "no-previous-run";
  // A failed read no retry fixes: warn, and no reconnect offered.
  const notKept = failure.kind === "log-not-kept";
  // The runtime drops a running container's log too. Only the run that was
  // asked for is known to be gone, so the way out exists only when the read
  // that failed was the earlier one.
  const offerCurrent = notKept && previousRun;
  const container = failure.container;
  // Why it is gone, which the stream error never says: it reports that
  // the container is no longer running, and the exit code, the reason
  // and the time are sitting in the pod's own status the whole while.
  const termination = info ? lastTermination(info) : null;
  const when = termination ? terminationWhen(termination, t) : null;

  return (
    <div
      role="alert"
      data-testid="log-stream-failure"
      className="flex flex-none items-start justify-between gap-3 border-b border-hair px-3 py-1.5"
    >
      <div className="min-w-0">
        <p
          className={`text-xs ${
            gone || absent || unstarted || notKept ? "text-warn" : "text-err"
          }`}
        >
          {notKept
            ? t("empty", "logNotKept", { container })
            : absent
              ? t("empty", "noPreviousRunOf", { container })
              : unstarted
                ? t("empty", "containerNotStarted", { container })
                : gone
                  ? t("empty", "streamEndedGone", { pod: podName, container })
                  : t("empty", "streamLost", { pod: podName, container })}
        </p>
        {unstarted && info.state.type === "waiting" && info.state.reason && (
          <p className="mt-0.5 text-[11px] text-fg-mut">
            {t("empty", "kubeletHoldingAt")}{" "}
            <span className="font-mono">{info.state.reason}</span>.
          </p>
        )}
        {termination && (
          <p
            className="mt-0.5 text-[11px] text-err"
            data-testid="log-stream-termination"
            title={terminationAt(termination)}
          >
            {t("empty", "itExited")} {describeTermination(termination)}
            {when ? `, ${when}` : ""}
            {info && info.restartCount > 0
              ? ` · ${t("count", "restartsSoFar", { n: info.restartCount })}`
              : ""}
            .
          </p>
        )}
        {!unstarted && (
          <p className="mt-0.5 wrap-break-word text-[11px] text-fg-mut">
            {failure.message}
          </p>
        )}
        {/* A stream that died under intake leaves two gaps, not one: the
            minutes it was down, and everything intake dropped before
            that. Reconnecting closes neither. */}
        {intake && !gone && !absent && !notKept && (
          <p className="mt-0.5 text-[11px] text-fg-fnt">
            {t("empty", "intakeStillSet")}
          </p>
        )}
      </div>
      {/* Not a retry: asking again cannot conjure a run that never
          happened. The way out is the run that does exist. */}
      {absent ? (
        <NoticeAction onClick={onShowCurrentRun}>
          {t("action", "showCurrentRun")}
        </NoticeAction>
      ) : offerCurrent ? (
        // Only the earlier run is known to be gone; the current one is a
        // read that has not been tried.
        <NoticeAction onClick={onShowCurrentRun}>
          {t("action", "showCurrentRun")}
        </NoticeAction>
      ) : notKept ? (
        <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-fg-fnt">
          {t("empty", "nothingToReconnectTo")}
        </span>
      ) : gone ? (
        <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-fg-fnt">
          {t("empty", "nothingToReconnectTo")}
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRetry}
        >
          <RefreshCw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
          {t("action", "reconnect")}
        </Button>
      )}
    </div>
  );
}

/**
 * The head of the log is being thrown away.
 *
 * A rising count in the corner reads as a tally of something that happened
 * once, while the pane above goes on looking like the whole log. This says
 * the loss in a sentence and puts the way out next to it — a download that
 * reads from the API rather than from the buffer, so it is not bounded by
 * the number that just failed the reader.
 */
export function DroppedNotice({
  dropped,
  limit,
  lost,
  onDownload,
}: {
  dropped: number;
  limit: number;
  lost: LostLines;
  onDownload: () => void;
}) {
  const t = useT();

  return (
    <div
      role="status"
      data-testid="log-dropped-notice"
      className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-hair px-3 py-1.5 text-[11px]"
    >
      <p className="text-warn">
        {t(
          "count",
          lost === "head" ? "olderLinesDropped" : "linesDroppedAroundKept",
          { n: dropped, count: formatCount(dropped) }
        )}
        <span className="text-fg-mut">
          {" "}
          {t(
            "empty",
            lost === "head" ? "bufferHoldsNewest" : "bufferHoldsKeptAndNewest",
            { count: formatCount(limit) }
          )}
        </span>
      </p>
      <Button variant="outline" size="sm" onClick={onDownload}>
        <Download aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
        {t("action", "downloadFullLog")}
      </Button>
    </div>
  );
}

/**
 * The grouping is doing all the work, said where the work is happening.
 *
 * A container that writes the same line a thousand times collapses to one
 * row — the right answer, and indistinguishable from a broken pane: a
 * single line over 700px of nothing, with `1 shown · 4 025 hidden by
 * filter and grouping` in 11px at the far corner. The count was never the
 * problem; its distance from the emptiness it explained was.
 */
export function GroupedNotice({
  rows,
  collapsed,
  onShowEveryLine,
}: {
  rows: number;
  collapsed: number;
  onShowEveryLine: () => void;
}) {
  const t = useT();

  return (
    <div
      role="status"
      data-testid="log-grouped-notice"
      className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-hair px-3 py-1.5 text-[11px] text-fg-mut"
    >
      <p>
        {t("count", "rowsStandFor", { n: rows })}{" "}
        {t("count", "forLines", {
          n: rows + collapsed,
          count: formatCount(rows + collapsed),
        })}
        <span className="text-fg-fnt"> {t("empty", "repeatsOnNote")}</span>
      </p>
      <button
        type="button"
        onClick={onShowEveryLine}
        className="shrink-0 rounded px-1.5 py-0.5 text-info hover:bg-hover"
      >
        {t("action", "showEveryLine")}
      </button>
    </div>
  );
}

/**
 * How long a stream under intake may say nothing before the pane says
 * why. Short enough to answer the question while it is being asked,
 * long enough that an ordinary gap between bursts does not trip it.
 */
const INTAKE_QUIET_MS = 12000;

/**
 * Nothing has matched intake for a while — which looks exactly like a
 * stream that died.
 *
 * That is the one ambiguity intake introduces: a still pane is either a
 * narrow filter working or a connection that dropped, and the reader
 * cannot tell them apart by looking. This says which, names the terms
 * doing it, and keeps counting so the silence reads as measured rather
 * than as a freeze. Its own component because the clock ticks every
 * second and the list beside it holds thousands of rows.
 */
export function IntakeQuietNotice({
  since,
  terms,
}: {
  since: number;
  terms: QueryTerm[];
}) {
  const t = useT();
  const now = useNowSeconds();

  const quiet = now - since;
  if (quiet < INTAKE_QUIET_MS) return null;

  return (
    <div
      role="status"
      data-testid="log-intake-quiet"
      className="flex-none border-b border-hair px-3 py-1.5 text-[11px] text-fg-mut"
    >
      <span aria-hidden="true" className="text-info">
        ⇣{" "}
      </span>
      {t("empty", "nothingHasMatched")}{" "}
      <span className="font-mono text-info">
        {terms.map(termLabel).join(" and ")}
      </span>{" "}
      {t("empty", "forSpan", { span: formatSpan(quiet) })}
      <span className="text-fg-fnt"> {t("empty", "intakeNarrowNote")}</span>
    </div>
  );
}

/**
 * The pane opened somewhere the reader did not put it, said out loud.
 *
 * Two narrowings the viewer applies on its own — one container instead of
 * all of them, one run instead of the current one — and both are lies
 * unless stated where the reader is looking.
 */
export function FocusNotice({
  reason,
  onShowAll,
  onShowCurrentRun,
}: {
  reason: FocusReason;
  onShowAll: () => void;
  onShowCurrentRun: () => void;
}) {
  const t = useT();
  const split = reason.kind === "phase-split";
  const readingPrevious =
    reason.kind === "previous-run" ||
    (reason.kind === "failing-init" && reason.previous);
  return (
    <div
      role="status"
      data-testid="log-focus-notice"
      className={`flex flex-none flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair px-3 py-1.5 text-[11px] ${
        split ? "text-fg-mut" : "text-warn"
      }`}
    >
      {reason.kind === "failing-init" && (
        <p>
          {t("empty", "openedOn")}{" "}
          <span className="font-mono">{reason.container}</span>{" "}
          {t("empty", "openedOnAloneInit")}
          {reason.previous && <span> {t("empty", "linesOfFailedRun")}</span>}
        </p>
      )}
      {reason.kind === "previous-run" && (
        <p>
          {t("empty", "showingRunOf")}{" "}
          <span className="font-mono">{reason.container}</span>{" "}
          {t("empty", "thatFailedNotCurrent")}
        </p>
      )}
      {reason.kind === "phase-split" && (
        <p>
          <span className="font-mono">{reason.containers.join(", ")}</span>{" "}
          {t("empty", "ranBeforePodStarted")}
        </p>
      )}
      <div className="ml-auto flex items-center gap-3">
        {readingPrevious && (
          <NoticeAction onClick={onShowCurrentRun}>
            {t("action", "showCurrentRun")}
          </NoticeAction>
        )}
        {reason.kind !== "previous-run" && (
          <NoticeAction onClick={onShowAll}>
            {split
              ? t("action", "interleaveAnyway")
              : t("action", "showEveryContainer")}
          </NoticeAction>
        )}
      </div>
    </div>
  );
}

/**
 * A finished container's log is complete, and a pane cannot show that.
 *
 * An init container that ended twenty minutes ago looks exactly like an
 * app container that has gone quiet, down to Follow sitting there doing
 * nothing. The difference is not visible anywhere in the output, so it
 * is stated above it.
 */
export function FinishedNotice({ container }: { container: ContainerInfo }) {
  const t = useT();
  const termination = lastTermination(container);
  const when = termination ? terminationWhen(termination, t) : null;
  const kind =
    container.phase === "sidecar"
      ? t("empty", "aSidecar")
      : t("empty", "anInitContainer");
  return (
    <div
      role="status"
      data-testid="log-finished-notice"
      className="flex-none border-b border-hair px-3 py-1.5 text-[11px] text-fg-mut"
      title={termination ? terminationAt(termination) : undefined}
    >
      {t("empty", "reading")}{" "}
      <span className="font-mono">{container.name}</span>, {kind}.{" "}
      {t("empty", "itFinished")}
      {when ? ` ${when}` : ""}
      {t("empty", "soLogIsComplete")}
    </div>
  );
}

/**
 * Every container in view answering "there is nothing earlier", in one
 * line instead of one banner each.
 *
 * A pod whose containers have never restarted has as many of these to say
 * as it has containers, and said separately they bury the log they are
 * describing. It is one fact about the pane: this run does not exist, and
 * the current one does.
 */
export function NoEarlierRunNotice({
  containers,
  onShowCurrentRun,
}: {
  containers: string[];
  onShowCurrentRun: () => void;
}) {
  const t = useT();

  return (
    <div
      role="status"
      data-testid="log-no-earlier-run"
      className="flex flex-none flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair px-3 py-1.5 text-[11px] text-warn"
    >
      <p>
        {t("empty", "noEarlierRunOf")}{" "}
        <span className="font-mono">{containers.join(", ")}</span>{" "}
        {t("empty", "noneHasRestarted")}
      </p>
      <div className="ml-auto">
        <NoticeAction onClick={onShowCurrentRun}>
          {t("action", "showCurrentRun")}
        </NoticeAction>
      </div>
    </div>
  );
}

function NoticeAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-info hover:bg-hover"
    >
      {children}
    </button>
  );
}
