import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Download, RefreshCw } from "lucide-react";
import type { ContainerInfo, LogLevel } from "@/generated/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { useCapabilityState } from "@/integrations";
import type { LogScope, UsageRange } from "@/integrations";
import { commands } from "@/lib/commands";
import {
  describeTermination,
  lastTermination,
  terminationAt,
  terminationWhen,
} from "@/lib/pod-status";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

import { initialFocus, type FocusReason } from "./focus";
import {
  useLogStream,
  DEFAULT_LOG_LIMIT,
  type ContainerFailure,
} from "./hooks/useLogStream";
import { useLogHistory } from "./hooks/useLogHistory";
import { useIntake } from "./hooks/useIntake";
import { LogHistoryBar } from "./LogHistoryBar";
import { LogToolbar } from "./LogToolbar";
import { LogLegend } from "./LogLegend";
import { LogList } from "./LogList";
import { LogDensityStrip } from "./LogDensityStrip";
import { LogStatusBar } from "./LogStatusBar";
import { containerColors as buildContainerColors } from "./container-colors";
import {
  countCollapsed,
  expandRuns,
  groupConsecutive,
  type LogRun,
} from "./grouping";
import {
  fieldTerm,
  formatCount,
  formatSpan,
  logsToText,
  matchesQuery,
  termLabel,
  type QueryTerm,
  type ViewMode,
} from "./types";

/** Before the first batch there is no index to read the legend's tally from. */
const EMPTY_COUNTS: Map<string, number> = new Map();

/** Ragged bars at log-line rhythm — the shape the output will land in. */
const SKELETON_WIDTHS = [
  "w-[78%]",
  "w-[54%]",
  "w-[88%]",
  "w-[41%]",
  "w-[70%]",
  "w-[62%]",
  "w-[84%]",
  "w-[48%]",
];

function LogSkeleton() {
  return (
    <div
      className="space-y-1.5 p-2"
      aria-hidden="true"
      data-testid="log-skeleton"
    >
      {SKELETON_WIDTHS.map((width, index) => (
        <Skeleton key={index} className={`h-2.5 ${width}`} />
      ))}
    </div>
  );
}

/**
 * A stream that stopped on its own, said out loud.
 *
 * It sits above the output rather than replacing it: a pod deleted
 * after an hour of logs still has an hour of logs worth reading, and
 * swapping them for an error message would be its own kind of lie. The
 * two kinds read differently on purpose — a deleted pod is a fact and
 * gets no button, a broken connection is a maybe and gets Reconnect.
 */
function StreamFailureNotice({
  failure,
  podName,
  container: info,
  intake,
  onRetry,
  onShowCurrentRun,
}: {
  failure: ContainerFailure;
  podName: string;
  /** The container's own status, when the pod object is at hand. */
  container?: ContainerInfo;
  /** Intake is set, so reconnecting will not fetch back the gap. */
  intake: boolean;
  onRetry: () => void;
  /** The way out of an earlier run that does not exist. */
  onShowCurrentRun: () => void;
}) {
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
  const container = failure.container;
  // Why it is gone, which the stream error never says: it reports that
  // the container is no longer running, and the exit code, the reason
  // and the time are sitting in the pod's own status the whole while.
  const termination = info ? lastTermination(info) : null;
  const when = termination ? terminationWhen(termination) : null;

  return (
    <div
      role="alert"
      data-testid="log-stream-failure"
      className="flex flex-none items-start justify-between gap-3 border-b border-hair px-3 py-1.5"
    >
      <div className="min-w-0">
        <p
          className={`text-xs ${gone || absent || unstarted ? "text-warn" : "text-err"}`}
        >
          {absent
            ? `No previous run of ${container} — it has not restarted.`
            : unstarted
              ? `${container} has not started, so it has nothing to say yet.`
              : gone
                ? `Stream ended — ${podName}/${container} is gone.`
                : `Lost the log stream from ${podName}/${container}.`}
        </p>
        {unstarted && info.state.type === "waiting" && info.state.reason && (
          <p className="mt-0.5 text-[11px] text-fg-mut">
            The kubelet is holding it at{" "}
            <span className="font-mono">{info.state.reason}</span>.
          </p>
        )}
        {termination && (
          <p
            className="mt-0.5 text-[11px] text-err"
            data-testid="log-stream-termination"
            title={terminationAt(termination)}
          >
            It exited {describeTermination(termination)}
            {when ? `, ${when}` : ""}
            {info && info.restartCount > 0
              ? ` · ${info.restartCount} ${info.restartCount === 1 ? "restart" : "restarts"} so far`
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
        {intake && !gone && !absent && (
          <p className="mt-0.5 text-[11px] text-fg-fnt">
            Intake is still set — reconnecting resumes from now, and what the
            stream missed is not fetched back.
          </p>
        )}
      </div>
      {/* Not a retry: asking again cannot conjure a run that never
          happened. The way out is the run that does exist. */}
      {absent ? (
        <NoticeAction onClick={onShowCurrentRun}>
          Show the current run
        </NoticeAction>
      ) : gone ? (
        <span className="shrink-0 whitespace-nowrap pt-0.5 text-[11px] text-fg-fnt">
          Nothing left to reconnect to
        </span>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRetry}
        >
          <RefreshCw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
          Reconnect
        </Button>
      )}
    </div>
  );
}

/**
 * The head of the log is being thrown away, and it used to happen in
 * silence.
 *
 * A count in the corner that keeps rising reads as a tally of something
 * that happened once; the pane above it goes on looking like the whole
 * log. This says the loss in a sentence, and puts the way out next to it —
 * a download that reads from the API rather than from the buffer, so it is
 * not bounded by the number that just failed the reader.
 */
function DroppedNotice({
  dropped,
  limit,
  onDownload,
}: {
  dropped: number;
  limit: number;
  onDownload: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="log-dropped-notice"
      className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-hair px-3 py-1.5 text-[11px]"
    >
      <p className="text-warn">
        {formatCount(dropped)} older {dropped === 1 ? "line has" : "lines have"}{" "}
        been dropped.
        <span className="text-fg-mut">
          {" "}
          The buffer holds the newest {formatCount(limit)}; what came before is
          no longer here.
        </span>
      </p>
      <Button variant="outline" size="sm" onClick={onDownload}>
        <Download aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
        Download the full log
      </Button>
    </div>
  );
}

/**
 * Few enough rows that the pane reads as empty rather than as short, and
 * enough lines behind them that the emptiness is a lie.
 */
const COLLAPSED_ROWS = 12;
const COLLAPSED_LINES = 50;

/**
 * The grouping is doing all the work, said where the work is happening.
 *
 * A container that writes the same line a thousand times collapses to one
 * row, which is the right answer and looks exactly like a broken pane: a
 * single line over 700px of nothing, with `1 shown · 4 025 hidden by
 * filter and grouping` in 11px at the far corner. The count was never the
 * problem — its distance from the emptiness it explained was. This says
 * it at the top of the list, next to the way out.
 */
function GroupedNotice({
  rows,
  collapsed,
  onShowEveryLine,
}: {
  rows: number;
  collapsed: number;
  onShowEveryLine: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="log-grouped-notice"
      className="flex flex-none flex-wrap items-center justify-between gap-2 border-b border-hair px-3 py-1.5 text-[11px] text-fg-mut"
    >
      <p>
        {rows === 1 ? "This row stands" : `These ${rows} rows stand`} for{" "}
        {formatCount(rows + collapsed)} lines.
        <span className="text-fg-fnt">
          {" "}
          Repeats is on, so a line that says what the one above it said is
          folded into it.
        </span>
      </p>
      <button
        type="button"
        onClick={onShowEveryLine}
        className="shrink-0 rounded px-1.5 py-0.5 text-info hover:bg-hover"
      >
        Show every line
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
 * That is the one ambiguity intake introduces: a pane that has gone
 * still is either a narrow filter working or a connection that dropped,
 * and the reader cannot tell them apart by looking. This says which,
 * names the terms doing it, and keeps counting so the silence reads as
 * measured rather than as a freeze. Its own component because the clock
 * ticks every second and the list beside it holds thousands of rows.
 */
function IntakeQuietNotice({
  since,
  terms,
}: {
  since: number;
  terms: QueryTerm[];
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

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
      Nothing has matched{" "}
      <span className="font-mono text-info">
        {terms.map(termLabel).join(" and ")}
      </span>{" "}
      for {formatSpan(quiet)}.
      <span className="text-fg-fnt">
        {" "}
        The stream is attached and reading — this is intake being narrow, not
        the log stopping.
      </span>
    </div>
  );
}

/**
 * The pane opened somewhere the reader did not put it, said out loud.
 *
 * Two narrowings the viewer applies on its own — one container instead
 * of all of them, one run instead of the current one — and both of them
 * are lies unless they are stated where the reader is looking. A log
 * that silently shows history is the worst kind of log.
 */
function FocusNotice({
  reason,
  onShowAll,
  onShowCurrentRun,
}: {
  reason: FocusReason;
  onShowAll: () => void;
  onShowCurrentRun: () => void;
}) {
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
          Opened on <span className="font-mono">{reason.container}</span> alone
          — the pod is stuck in init, so nothing after it has written a line.
          {reason.previous && (
            <span>
              {" "}
              These are the lines of the run that failed, not of the current
              one.
            </span>
          )}
        </p>
      )}
      {reason.kind === "previous-run" && (
        <p>
          Showing the run of{" "}
          <span className="font-mono">{reason.container}</span> that failed, not
          the current one — it has restarted since, and the current run has
          printed nothing yet.
        </p>
      )}
      {reason.kind === "phase-split" && (
        <p>
          <span className="font-mono">{reason.containers.join(", ")}</span> ran
          before the pod started, minutes older than everything else here — held
          out rather than interleaved at the top of the buffer.
        </p>
      )}
      <div className="ml-auto flex items-center gap-3">
        {readingPrevious && (
          <NoticeAction onClick={onShowCurrentRun}>
            Show the current run
          </NoticeAction>
        )}
        {reason.kind !== "previous-run" && (
          <NoticeAction onClick={onShowAll}>
            {split ? "Interleave them anyway" : "Show every container"}
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
function FinishedNotice({ container }: { container: ContainerInfo }) {
  const termination = lastTermination(container);
  const when = termination ? terminationWhen(termination) : null;
  const kind =
    container.phase === "sidecar" ? "a sidecar" : "an init container";
  return (
    <div
      role="status"
      data-testid="log-finished-notice"
      className="flex-none border-b border-hair px-3 py-1.5 text-[11px] text-fg-mut"
      title={termination ? terminationAt(termination) : undefined}
    >
      Reading <span className="font-mono">{container.name}</span>, {kind}. It
      finished{when ? ` ${when}` : ""}, so this log is complete and will not
      grow.
    </div>
  );
}

/**
 * Every container in view answering "there is nothing earlier", in one
 * line instead of one banner each.
 *
 * A pod whose containers have never restarted has as many of these to
 * say as it has containers, and said separately they buried the log they
 * were describing. It is one fact about the pane: this run does not
 * exist, and the current one does.
 */
function NoEarlierRunNotice({
  containers,
  onShowCurrentRun,
}: {
  containers: string[];
  onShowCurrentRun: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="log-no-earlier-run"
      className="flex flex-none flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-hair px-3 py-1.5 text-[11px] text-warn"
    >
      <p>
        No earlier run of{" "}
        <span className="font-mono">{containers.join(", ")}</span> — none of
        them has restarted, so there is nothing before the run they are on.
      </p>
      <div className="ml-auto">
        <NoticeAction onClick={onShowCurrentRun}>
          Show the current run
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

/**
 * Digits solo by the position the legend draws, `0` shows everything.
 *
 * Bound on the window rather than on the legend because the reader's
 * focus is in the query box or nowhere at all, and a shortcut that
 * needs the legend focused first is not a shortcut. Two guards keep it
 * honest: a digit typed into the query is a digit, and a viewer parked
 * behind a hidden tab must not answer for the one on screen.
 */
function useSoloShortcuts(
  root: React.RefObject<HTMLElement | null>,
  count: number,
  onSolo: (index: number) => void,
  onShowAll: () => void
) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[0-9]$/.test(event.key)) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      const node = root.current;
      if (!node || !node.isConnected || node.closest("[hidden]")) return;

      const digit = Number(event.key);
      if (digit === 0) {
        event.preventDefault();
        onShowAll();
        return;
      }
      if (digit > count) return;
      event.preventDefault();
      onSolo(digit - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [root, count, onSolo, onShowAll]);
}

interface LogViewerProps {
  podName: string;
  namespace: string;
  /**
   * Every container the pod ran, init first and in run order — see
   * `podContainers`. Not just their names: a stream that ends because a
   * container died can only say why if it can reach that container's
   * `lastTerminated`, and which run to open on is decided from the same
   * field.
   */
  containers: ContainerInfo[];
  /**
   * A container to open alone, asked for from the Containers tab. Read
   * once, on mount, which is why the caller keys the viewer by it: a
   * request that arrives mid-session is a different reading of a
   * different log, not a filter change.
   */
  soloContainer?: string | null;
  /**
   * The controller this pane's pod belongs to, where the caller is looking at
   * one — a workload's Logs tab rather than a pod's.
   *
   * It changes one thing and nothing else: a range read from a log store is
   * asked about the *workload* instead of about the pod on screen, so it
   * spans the pods the workload has had rather than the one that happens to
   * be selected. The live half of the pane is unaffected — it is still one
   * pod's streams, because that is the only thing the API server will follow.
   */
  workload?: { owner: string; ownerKind: string } | null;
}

export function LogViewer({
  podName,
  namespace,
  containers: containerInfos,
  soloContainer,
  workload,
}: LogViewerProps) {
  const { toast } = useToast();
  const containers = useMemo(
    () => containerInfos.map((container) => container.name),
    [containerInfos]
  );
  const copyToClipboard = useCopyToClipboard();
  // Every container streams, always. Hiding one is a view filter and
  // nothing more: stopping its stream would make its line count a lie
  // the moment it came back, and a sidecar bug is invisible one
  // container at a time.
  //
  // And nothing is hidden on open. The pane used to be handed the first
  // container of the pod as a starting filter, which on a five-container
  // workload meant it opened showing a fifth of the log with no statement
  // anywhere near the reader that four fifths were being withheld. A
  // filter the reader did not set is not a filter, it is a lie about how
  // much log there is.
  //
  // Except when the pod is held in init. Then "show everything" shows
  // nothing — the app container has never started — and the one log
  // that answers the question is the failing init container's previous
  // run. Decided once, on mount, and announced above the output.
  const [focus] = useState(() => initialFocus(containerInfos, soloContainer));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(focus.hidden);
  const [previousRun, setPreviousRun] = useState(focus.previous);
  /** Retired the moment the reader touches the legend: it describes an
   *  opening state, and a stale explanation is worse than none. */
  const [focusReason, setFocusReason] = useState<FocusReason | null>(
    focus.reason
  );
  const [terms, setTerms] = useState<QueryTerm[]>([]);
  /**
   * Which terms are also kept at the source, by label.
   *
   * A mode per term rather than one intake control for the toolbar: the
   * reader mixes them — `component=ingest` worth restarting the stream
   * for, `level≥warn` worth flipping off a moment later without touching
   * it — and a single toolbar-wide intake cannot express that.
   *
   * Kept beside the terms rather than inside them because `QueryTerm` is
   * generated from Rust and is the shape the backend is handed; the mode
   * is the viewer's business alone.
   */
  const [intakeLabels, setIntakeLabels] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [draft, setDraft] = useState("");
  const [limit, setLimit] = useState(DEFAULT_LOG_LIMIT);
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<number>>(
    () => new Set()
  );
  const [expandedLines, setExpandedLines] = useState<ReadonlySet<number>>(
    () => new Set()
  );
  const [viewMode, setViewMode] = useState<ViewMode>("compact");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Where the reader is, in wall clock, so the strip can mark it. Two
  // numbers rather than an object: React bails out of the re-render when
  // neither has moved, and this is reported on every scroll and batch.
  const [viewportFrom, setViewportFrom] = useState(0);
  const [viewportTo, setViewportTo] = useState(0);
  const [scrollTarget, setScrollTarget] = useState<{ index: number } | null>(
    null
  );

  // Remembered like the table density and shared with the peek: whether a
  // chart belongs over a log is a fact about the reader, not about the pane
  // they happen to be reading in.
  const stripMode = useDisplaySettingsStore((state) => state.densityStrip);
  const setStripMode = useDisplaySettingsStore(
    (state) => state.setDensityStrip
  );

  // Every chip filters the view; the ones flipped to intake also filter
  // the stream, so the toggle changes what is kept and never what is
  // shown. `useIntake` holds the set still for a moment so a run of
  // flips is one restart.
  const intakeTerms = useMemo(
    () => terms.filter((term) => intakeLabels.has(termLabel(term))),
    [terms, intakeLabels]
  );
  const intake = useIntake(intakeTerms);

  const {
    logs: live,
    fields,
    dropped,
    isStreaming,
    isConnecting,
    isPaused,
    failures,
    lastBatchAt,
    intakeFrom,
    unfilteredFrom,
    clearLogs,
    togglePause,
    retry,
  } = useLogStream({
    podName,
    namespace,
    containers,
    limit,
    previous: previousRun,
    intake,
  });

  const colors = useMemo(() => buildContainerColors(containers), [containers]);

  // A pod's own lines outlive the pod only if somebody shipped them
  // somewhere. Asked for by facet, so this pane never learns which store
  // answered — it prints the name it is handed and branches on nothing.
  const historyCapability = useCapabilityState("logs.history");
  const history = useLogHistory(
    historyCapability.state === "ready" ? historyCapability.use : null
  );
  const [historyRange, setHistoryRange] = useState<UsageRange | null>(null);

  /**
   * What a range is asked about: the workload where there is one, the pod
   * otherwise.
   *
   * The workload scope is the reason this is worth having on a Logs tab at
   * all — its pods from an hour ago are gone from every list the API server
   * will answer, and they are exactly the ones somebody debugging a rollout
   * came to read.
   */
  const historyScope = useMemo<LogScope>(
    () =>
      workload
        ? {
            kind: "workload",
            namespace,
            owner: workload.owner,
            ownerKind: workload.ownerKind,
          }
        : { kind: "pod", namespace, pod: podName },
    [workload, namespace, podName]
  );

  const handleReadHistory = useCallback(
    (range: UsageRange) => {
      setHistoryRange(range);
      history.read(historyScope, range);
    },
    [history, historyScope]
  );

  const handleClearHistory = useCallback(() => {
    setHistoryRange(null);
    history.clear();
  }, [history]);

  /**
   * History in front of the live buffer, and **the first thing to go when
   * the buffer is full**.
   *
   * That order is the contract, not an implementation detail: the live
   * stream is the answer this pane owed before any integration existed, and
   * a range that pushed live lines out of a `Keep 5 000` buffer would have
   * made the viewer worse for having a Loki.
   */
  const { logs, historyHeld } = useMemo(() => {
    if (history.lines.length === 0) return { logs: live, historyHeld: 0 };
    const room = Math.max(0, limit - live.length);
    const kept =
      room >= history.lines.length
        ? history.lines
        : history.lines.slice(history.lines.length - room);
    return { logs: [...kept, ...live], historyHeld: kept.length };
  }, [history.lines, live, limit]);

  // Everything the pane is holding, history included — the status bar's fill
  // and the "N lines received" sentences are about the buffer on screen and
  // not about which half of it arrived over a socket.
  const retained = logs.length;

  // Counted over the whole buffer rather than the view, so hiding a
  // container does not zero the number that says how loud it is. The
  // field index already keeps exactly this tally, incrementally, so the
  // legend no longer costs a pass over the buffer per batch.
  const counts = fields.values.get("container") ?? EMPTY_COUNTS;

  // What is being typed filters live and becomes a chip on Enter, so the
  // box answers immediately and the answer survives being typed past.
  const effectiveTerms = useMemo<QueryTerm[]>(() => {
    const typed = draft.trim();
    return typed === "" ? terms : [...terms, { kind: "text", value: typed }];
  }, [terms, draft]);

  const highlight = useMemo(() => {
    const typed = draft.trim();
    if (typed !== "") return typed;
    const text = terms.filter((term) => term.kind === "text");
    return text.length > 0 ? text[text.length - 1].value : "";
  }, [terms, draft]);

  /**
   * Two filtered views, because the strip and the list are not asking the
   * same question.
   *
   * `scoped` is everything the query allows except the time range;
   * `visibleLogs` is that narrowed to the range. The strip draws `scoped`
   * so the map keeps its full extent while a range is selected — filter
   * the strip by its own selection and dragging out four minutes leaves a
   * strip of four minutes, with nowhere left to drag back to.
   */
  const { scoped, visibleLogs } = useMemo(() => {
    const time = effectiveTerms.find((term) => term.kind === "time");
    const rest = time
      ? effectiveTerms.filter((term) => term.kind !== "time")
      : effectiveTerms;
    const scoped = logs.filter(
      (log) => !hidden.has(log.container) && matchesQuery(log, rest)
    );
    return {
      scoped,
      visibleLogs: time
        ? scoped.filter((log) => log.epoch >= time.from && log.epoch <= time.to)
        : scoped,
    };
  }, [logs, hidden, effectiveTerms]);

  const timeRange = useMemo(() => {
    const term = terms.find((entry) => entry.kind === "time");
    return term ? { from: term.from, to: term.to } : null;
  }, [terms]);

  // What the strip's accumulator treats as "the same set, extended".
  // Anything that reshuffles the filtered array has to appear here or the
  // histogram would go on adding to slices built from a different query.
  const scopeKey = useMemo(
    () =>
      `${namespace}/${podName}|${[...hidden].sort().join(",")}|${effectiveTerms
        .filter((term) => term.kind !== "time")
        .map(termLabel)
        .join(",")}`,
    [namespace, podName, hidden, effectiveTerms]
  );

  // Grouping runs after filtering, so a filter that leaves two repeats
  // adjacent collapses them — the reader asked to see only these.
  const runs = useMemo(
    () => groupConsecutive(visibleLogs, collapseRepeats),
    [visibleLogs, collapseRepeats]
  );
  const rows = useMemo(
    () => expandRuns(visibleLogs, runs, expandedRuns),
    [visibleLogs, runs, expandedRuns]
  );
  const collapsedCount = useMemo(() => countCollapsed(runs), [runs]);

  const handleViewportRange = useCallback((from: number, to: number) => {
    setViewportFrom(from);
    setViewportTo(to);
  }, []);

  /**
   * A slice, clicked. The follow has to come off in the same update — a
   * list still pinned to the tail would scroll back within the quarter
   * second, and the click would read as broken rather than as ignored.
   */
  const handleJumpToTime = useCallback(
    (epoch: number) => {
      if (rows.length === 0) return;
      setAutoScroll(false);
      setIsAtBottom(false);
      setScrollTarget({ index: firstRowAtOrAfter(rows, epoch) });
    },
    [rows]
  );

  // At most one time range at a time, so a second drag replaces the first
  // rather than intersecting with it — two ranges anded together is a
  // question nobody asked by dragging.
  const handleSelectRange = useCallback((from: number, to: number) => {
    setAutoScroll(false);
    setTerms((prev) => [
      ...prev.filter((term) => term.kind !== "time"),
      { kind: "time", from, to },
    ]);
  }, []);

  const handleClearRange = useCallback(() => {
    setTerms((prev) => prev.filter((term) => term.kind !== "time"));
  }, []);

  const handleToggleRun = useCallback((id: number) => {
    setExpandedRuns((prev) => toggled(prev, id));
  }, []);

  const handleToggleLine = useCallback((id: number) => {
    setExpandedLines((prev) => toggled(prev, id));
  }, []);

  const handleToggleContainer = useCallback((name: string) => {
    setFocusReason(null);
    setHidden((prev) => toggled(prev, name));
  }, []);

  const handleShowAllContainers = useCallback(() => {
    setFocusReason(null);
    setHidden(new Set());
  }, []);

  /**
   * Everything else off — or, on the container that is already alone,
   * everything back on. One gesture in both directions, which is what
   * makes it safe to reach for on a five-container pod.
   */
  const handleSoloContainer = useCallback(
    (name: string) => {
      setFocusReason(null);
      setHidden((prev) => {
        const alone = !prev.has(name) && containers.length - prev.size === 1;
        return alone
          ? new Set()
          : new Set(containers.filter((other) => other !== name));
      });
    },
    [containers]
  );

  const handleSoloByIndex = useCallback(
    (index: number) => {
      const name = containers[index];
      if (name !== undefined) handleSoloContainer(name);
    },
    [containers, handleSoloContainer]
  );

  const rootRef = useRef<HTMLDivElement>(null);
  useSoloShortcuts(
    rootRef,
    containers.length,
    handleSoloByIndex,
    handleShowAllContainers
  );

  const handlePreviousRunToggle = useCallback(() => {
    setFocusReason(null);
    setPreviousRun((on) => !on);
  }, []);

  const handleShowCurrentRun = useCallback(() => {
    setFocusReason(null);
    setPreviousRun(false);
  }, []);

  const handleAddTerm = useCallback((term: QueryTerm) => {
    setTerms((prev) =>
      prev.some((existing) => termLabel(existing) === termLabel(term))
        ? prev
        : [...prev, term]
    );
  }, []);

  const handleRemoveTerm = useCallback((term: QueryTerm) => {
    const label = termLabel(term);
    setTerms((prev) =>
      prev.filter((existing) => termLabel(existing) !== label)
    );
    // Taking the chip away takes its intake with it — which restarts the
    // stream, and the same sentence gets said about the gap.
    setIntakeLabels((prev) => (prev.has(label) ? without(prev, label) : prev));
  }, []);

  const handleToggleIntake = useCallback((term: QueryTerm) => {
    setIntakeLabels((prev) => toggled(prev, termLabel(term)));
  }, []);

  const handleClearQuery = useCallback(() => {
    setTerms([]);
    setIntakeLabels(new Set());
    setDraft("");
  }, []);

  // One builder for every pair anyone clicks — a row's field key, the
  // container in its detail, the level in the Table view, a suggestion in
  // the query popover. Two of them producing terms that only looked alike
  // would defeat the label-based dedupe and stack two chips saying the
  // same thing.
  const handleFieldClick = useCallback(
    (key: string, value: string) => {
      handleAddTerm(fieldTerm(key, value));
    },
    [handleAddTerm]
  );

  const handleLevelClick = useCallback(
    (level: LogLevel) => {
      handleAddTerm(fieldTerm("level", level));
    },
    [handleAddTerm]
  );

  const handleAutoScrollToggle = useCallback(() => {
    // Turning it back on is the same act as jumping to the foot: the list
    // pins itself the moment `follow` flips true.
    setAutoScroll((previous) => !previous);
  }, []);

  const handleCopyLogs = useCallback(() => {
    if (visibleLogs.length === 0) return;
    copyToClipboard(
      logsToText(visibleLogs),
      `${formatCount(visibleLogs.length)} ${visibleLogs.length === 1 ? "line" : "lines"} copied`
    );
  }, [copyToClipboard, visibleLogs]);

  const shownContainers = useMemo(
    () => containers.filter((name) => !hidden.has(name)),
    [containers, hidden]
  );

  const handleDownloadLogs = useCallback(async () => {
    // Straight from the API, not from the buffer: this is the answer to
    // "the head has been dropped", and reading the same truncated array
    // back out would be no answer at all. One file per container, because
    // `get_pod_logs` reads one container and interleaving several
    // one-shot reads would invent an ordering the API never gave.
    const targets = shownContainers.length > 0 ? shownContainers : containers;
    try {
      for (const container of targets) {
        const allLogs = await commands.getPodLogs(
          podName,
          namespace,
          container,
          10000,
          null,
          // The file has to be the log on screen. Downloading the current
          // run while the pane reads the previous one hands the reader a
          // different log under the same name.
          previousRun
        );
        const blob = new Blob([logsToText(allLogs)], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${podName}-${container}${previousRun ? "-previous" : ""}.log`;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error("Failed to download logs:", err);
      toast({
        title: "Download failed",
        description: "Could not read the log from the API",
        variant: "destructive",
      });
    }
  }, [containers, namespace, podName, previousRun, shownContainers, toast]);

  // What the reader is not being shown: dropped by the query or by the
  // legend, plus the lines standing behind a collapsed run.
  const hiddenByView = retained - visibleLogs.length + collapsedCount;

  // Offered where it can answer. The kubelet sets `lastTerminated` for
  // exactly the container instances whose logs `--previous` still
  // fetches, so this is knowable before asking rather than from an error.
  const offerPreviousRun = containerInfos.some(
    (info) => info.lastTerminated !== null
  );

  // A container reading alone, finished, from a phase of the pod's life
  // that is over. Derived from the current view rather than from the
  // opening one: it is as true after a solo as it was on mount.
  const finished = useMemo(() => {
    if (shownContainers.length !== 1) return null;
    const info = containerInfos.find(
      (entry) => entry.name === shownContainers[0]
    );
    if (!info || info.phase === "app" || info.state.type !== "terminated") {
      return null;
    }
    return info;
  }, [containerInfos, shownContainers]);

  // "There is no earlier run of this one" is a fact about a container,
  // not about the pane, and the legend chip already carries it beside the
  // name. It is only worth a banner when it is the whole answer — every
  // container in view saying it, so the pane is empty because of it.
  // Otherwise a three-container pod stacked three warnings over a log
  // that was reading perfectly well.
  const absentInView = failures.filter(
    (failure) =>
      failure.kind === "no-previous-run" && !hidden.has(failure.container)
  );
  const nothingEarlier =
    shownContainers.length > 0 &&
    absentInView.length === shownContainers.length;
  const bannered = failures.filter((failure) => {
    // Hiding a container hides everything about it, its trouble
    // included. A soloed pane that stacks three banners about
    // containers the reader took out of view is arguing with the
    // filter it was just given — the legend marks them, and unhiding
    // one brings its sentence back with it.
    if (hidden.has(failure.container)) return false;
    if (failure.kind === "no-previous-run") {
      return nothingEarlier && absentInView.length === 1;
    }
    // An init container that finished ends its stream on the way out.
    // That is the read completing, not the container disappearing —
    // the legend says "ended" and the notice above says the log is
    // whole, and "is gone" over a successful step is alarm for nothing.
    const info = containerInfos.find(
      (entry) => entry.name === failure.container
    );
    return !(failure.kind === "gone" && info?.state.type === "terminated");
  });

  /**
   * What the API server has run out of answers for, named.
   *
   * Exactly the two dead ends the pane already states in words above the
   * output — a stream that ended because the container is gone, and a
   * container that has never started — reused rather than re-derived, so the
   * offer cannot appear beside a notice that is not there or go missing
   * beside one that is. Everywhere else this is `null` and no offer is drawn.
   */
  const stranded = useMemo(() => {
    const gone = bannered
      .filter((failure) => failure.kind === "gone")
      .map((failure) => failure.container);
    if (gone.length > 0) return `${podName}/${gone.join(", ")}`;
    const unstarted = containerInfos.filter(
      (info) =>
        !hidden.has(info.name) &&
        info.state.type === "waiting" &&
        info.lastTerminated === null &&
        info.restartCount === 0
    );
    if (unstarted.length > 0) {
      return `${podName}/${unstarted.map((info) => info.name).join(", ")}`;
    }
    return null;
  }, [bannered, containerInfos, hidden, podName]);

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      {/* Above the toolbar because it is the first question, not the
          fourth: the shape of the buffer is what tells the reader where
          to point the query. Hidden outright, it leaves nothing behind —
          the ⋯ menu is where it went and where it comes back from. */}
      {stripMode !== "off" && (
        <LogDensityStrip
          logs={scoped}
          scope={scopeKey}
          retained={retained}
          headDropped={dropped > 0}
          intake={intake.length > 0}
          selection={timeRange}
          viewportFrom={viewportFrom}
          viewportTo={viewportTo}
          onJump={handleJumpToTime}
          onSelect={handleSelectRange}
          onClearSelection={handleClearRange}
          mode={stripMode}
          onModeChange={setStripMode}
        />
      )}

      <LogToolbar
        terms={terms}
        draft={draft}
        onDraftChange={setDraft}
        onAddTerm={handleAddTerm}
        onRemoveTerm={handleRemoveTerm}
        intake={intakeLabels}
        onToggleIntake={handleToggleIntake}
        fields={fields}
        limit={limit}
        onLimitChange={setLimit}
        collapseRepeats={collapseRepeats}
        onCollapseRepeatsChange={setCollapseRepeats}
        previousRun={previousRun}
        offerPreviousRun={offerPreviousRun}
        onPreviousRunToggle={handlePreviousRunToggle}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isStreaming={isStreaming}
        isConnecting={isConnecting}
        isPaused={isPaused}
        autoScroll={autoScroll}
        isAtBottom={isAtBottom}
        onAutoScrollToggle={handleAutoScrollToggle}
        onClearLogs={clearLogs}
        onCopyLogs={handleCopyLogs}
        onDownloadLogs={handleDownloadLogs}
        onToggleStreaming={togglePause}
        stripMode={stripMode}
        onStripModeChange={setStripMode}
      />

      <LogLegend
        containers={containerInfos}
        colors={colors}
        counts={counts}
        hidden={hidden}
        failures={failures}
        onToggle={handleToggleContainer}
        onSolo={handleSoloContainer}
        onShowAll={handleShowAllContainers}
      />

      {/* Directly under the legend it narrowed, and above everything that
          explains the output — the reader has to know which containers
          and which run these lines are before reading a line of them. */}
      {focusReason && (
        <FocusNotice
          reason={focusReason}
          onShowAll={handleShowAllContainers}
          onShowCurrentRun={handleShowCurrentRun}
        />
      )}

      {/* Not while a failure above is already accounting for the pane: a
          finished container whose earlier run does not exist would
          otherwise be told its complete log is on screen when nothing
          is. */}
      {!focusReason &&
        finished &&
        !bannered.some((failure) => failure.container === finished.name) && (
          <FinishedNotice container={finished} />
        )}

      {nothingEarlier && absentInView.length > 1 && (
        <NoEarlierRunNotice
          containers={absentInView.map((failure) => failure.container)}
          onShowCurrentRun={handleShowCurrentRun}
        />
      )}

      {dropped > 0 && (
        <DroppedNotice
          dropped={dropped}
          limit={limit}
          onDownload={handleDownloadLogs}
        />
      )}

      {/* One notice per container whose stream died. Four containers can
          still be streaming while the fifth is gone, and a single verdict
          could not say which. */}
      {bannered.map((failure) => (
        <StreamFailureNotice
          key={failure.container}
          failure={failure}
          podName={podName}
          container={containerInfos.find(
            (info) => info.name === failure.container
          )}
          intake={intake.length > 0}
          onRetry={retry}
          onShowCurrentRun={handleShowCurrentRun}
        />
      ))}

      {/* Under the sentence that said there is nothing left to read, which
          is the only place an offer to read it elsewhere makes sense. */}
      <LogHistoryBar
        capability={historyCapability}
        history={history.state}
        stranded={stranded}
        ranged={workload !== undefined && workload !== null}
        held={historyHeld}
        keep={limit}
        selected={historyRange}
        isPaging={history.isPaging}
        onRead={handleReadHistory}
        onReadOlder={history.readOlder}
        onClear={handleClearHistory}
      />

      {/* Only while the stream is up and nothing else is explaining the
          silence: a failed stream has its own notice above, and two
          verdicts about the same quiet would compete. */}
      {intake.length > 0 && isStreaming && failures.length === 0 && (
        <IntakeQuietNotice since={lastBatchAt} terms={intake} />
      )}

      {rows.length > 0 &&
        rows.length <= COLLAPSED_ROWS &&
        collapsedCount >= COLLAPSED_LINES && (
          <GroupedNotice
            rows={rows.length}
            collapsed={collapsedCount}
            onShowEveryLine={() => setCollapseRepeats(false)}
          />
        )}

      <LogList
        logs={visibleLogs}
        rows={rows}
        expandedRuns={expandedRuns}
        onToggleRun={handleToggleRun}
        expandedLines={expandedLines}
        onToggleLine={handleToggleLine}
        containerColors={colors}
        viewMode={viewMode}
        searchQuery={highlight}
        follow={autoScroll}
        atBottom={isAtBottom}
        onFollowChange={setAutoScroll}
        onAtBottomChange={setIsAtBottom}
        resetKey={`${namespace}/${podName}`}
        oldestRetainedId={logs[0]?.id}
        onViewportRangeChange={handleViewportRange}
        scrollTarget={scrollTarget}
        onFieldClick={handleFieldClick}
        onLevelClick={handleLevelClick}
      >
        <EmptyState
          failed={failures.length > 0}
          connecting={isConnecting}
          streaming={isStreaming}
          retained={retained}
          filtered={effectiveTerms.length > 0}
          intake={intake.length > 0}
          allHidden={shownContainers.length === 0 && containers.length > 0}
          onClearQuery={handleClearQuery}
          onShowAll={handleShowAllContainers}
        />
      </LogList>

      {/* The status bar carries the live indicator: a pulsing dot beside the
          word "Streaming", which is the only thing that separates an attached
          stream from a dead pane. */}
      <LogStatusBar
        logs={logs}
        retained={retained}
        limit={limit}
        shownCount={rows.length}
        hiddenCount={hiddenByView}
        intake={intake}
        intakeFrom={intakeFrom}
        unfilteredFrom={unfilteredFrom}
        isStreaming={isStreaming}
      />
    </div>
  );
}

/**
 * Why there is nothing to read. Five different silences, and the old pane
 * had one sentence for all of them.
 */
function EmptyState({
  failed,
  connecting,
  streaming,
  retained,
  filtered,
  intake,
  allHidden,
  onClearQuery,
  onShowAll,
}: {
  failed: boolean;
  connecting: boolean;
  streaming: boolean;
  retained: number;
  filtered: boolean;
  /** Set, so "received" and "kept" are no longer the same number. */
  intake: boolean;
  allHidden: boolean;
  onClearQuery: () => void;
  onShowAll: () => void;
}) {
  // The failure notice above already said what happened; a second verdict
  // under it would only compete with it.
  if (failed && retained === 0) return null;

  // Lines, not a spinner: the shape the output will take says "this is a
  // log about to arrive" where a spinner says only "wait".
  if (connecting && retained === 0) return <LogSkeleton />;

  if (allHidden) {
    return (
      <Note>
        Every container is hidden.
        <span className="text-fg-fnt">
          {" "}
          {formatCount(retained)} lines are buffered behind the legend.
        </span>
        <Action onClick={onShowAll}>Show all containers</Action>
      </Note>
    );
  }

  if (retained > 0) {
    return (
      <Note>
        {filtered ? "No line matches the query." : "Nothing left to show."}
        <span className="text-fg-fnt">
          {" "}
          {/* Under intake these are not the lines the container wrote:
              the rest were discarded before they got here, and clearing
              the query cannot bring them back. */}
          {formatCount(retained)} lines {intake ? "kept" : "received"}.
        </span>
        {filtered && <Action onClick={onClearQuery}>Clear the query</Action>}
      </Note>
    );
  }

  if (streaming) {
    return (
      <Note>
        No output yet.
        {/* Safe to claim the stream is attached now: a stream that dies
            emits `stream-failed`, which replaces this with the notice
            above. Before that event existed this branch also covered a
            broken connection and could not say so. */}
        <span className="text-fg-fnt">
          {" "}
          The stream is attached; nothing has been written since these
          containers started.
        </span>
      </Note>
    );
  }

  return (
    <Note>
      Not streaming.
      <span className="text-fg-fnt">
        {" "}
        Use the stream control in the toolbar to attach.
      </span>
    </Note>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div className="py-8 text-center text-xs text-fg-mut">{children}</div>;
}

function Action({
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
      className="mt-2 block w-full text-center text-xs text-info hover:underline"
    >
      {children}
    </button>
  );
}

/**
 * The first row at or after an instant.
 *
 * Binary search over the rows the list is actually drawing, not over the
 * buffer: a run of two thousand collapsed repeats is one row, and landing
 * on the line's index would put the reader thousands of rows past where
 * they pointed. Rows are ordered by time to within one reorder window,
 * which is finer than any slice the strip can draw.
 */
function firstRowAtOrAfter(rows: LogRun[], epoch: number): number {
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].tail.epoch < epoch) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Add or drop one member, without mutating the set the render read. */
function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

function without<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}
