import { useState, useCallback, useMemo, type ReactNode } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { LogLevel } from "@/generated/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";

import {
  useLogStream,
  DEFAULT_LOG_LIMIT,
  type ContainerFailure,
} from "./hooks/useLogStream";
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
  onRetry,
}: {
  failure: ContainerFailure;
  podName: string;
  onRetry: () => void;
}) {
  const gone = failure.kind === "gone";
  const container = failure.container;

  return (
    <div
      role="alert"
      data-testid="log-stream-failure"
      className="flex flex-none items-start justify-between gap-3 border-b border-hair px-3 py-1.5"
    >
      <div className="min-w-0">
        <p className={`text-xs ${gone ? "text-warn" : "text-err"}`}>
          {gone
            ? `Stream ended — ${podName}/${container} is gone.`
            : `Lost the log stream from ${podName}/${container}.`}
        </p>
        <p className="mt-0.5 break-words text-[11px] text-fg-mut">
          {failure.message}
        </p>
      </div>
      {gone ? (
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

interface LogViewerProps {
  podName: string;
  namespace: string;
  containers: string[];
  /** Opens with only this container shown; the rest are one click away. */
  initialContainer?: string;
}

export function LogViewer({
  podName,
  namespace,
  containers,
  initialContainer,
}: LogViewerProps) {
  const { toast } = useToast();
  const copyToClipboard = useCopyToClipboard();
  // Every container streams, always. Hiding one is a view filter and
  // nothing more: stopping its stream would make its line count a lie
  // the moment it came back, and a sidecar bug is invisible one
  // container at a time.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() =>
    initialContainer
      ? new Set(containers.filter((name) => name !== initialContainer))
      : new Set()
  );
  const [terms, setTerms] = useState<QueryTerm[]>([]);
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

  const {
    logs,
    retained,
    fields,
    dropped,
    isStreaming,
    isConnecting,
    isPaused,
    failures,
    clearLogs,
    togglePause,
    retry,
  } = useLogStream({ podName, namespace, containers, limit });

  const colors = useMemo(() => buildContainerColors(containers), [containers]);

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
    setHidden((prev) => toggled(prev, name));
  }, []);

  const handleShowAllContainers = useCallback(() => {
    setHidden(new Set());
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
  }, []);

  const handleClearQuery = useCallback(() => {
    setTerms([]);
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
          false
        );
        const blob = new Blob([logsToText(allLogs)], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${podName}-${container}.log`;
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
  }, [containers, namespace, podName, shownContainers, toast]);

  // What the reader is not being shown: dropped by the query or by the
  // legend, plus the lines standing behind a collapsed run.
  const hiddenByView = retained - visibleLogs.length + collapsedCount;

  return (
    <div className="flex h-full flex-col">
      {/* Above the toolbar because it is the first question, not the
          fourth: the shape of the buffer is what tells the reader where
          to point the query. */}
      <LogDensityStrip
        logs={scoped}
        scope={scopeKey}
        retained={retained}
        headDropped={dropped > 0}
        selection={timeRange}
        viewportFrom={viewportFrom}
        viewportTo={viewportTo}
        onJump={handleJumpToTime}
        onSelect={handleSelectRange}
        onClearSelection={handleClearRange}
      />

      <LogToolbar
        terms={terms}
        draft={draft}
        onDraftChange={setDraft}
        onAddTerm={handleAddTerm}
        onRemoveTerm={handleRemoveTerm}
        fields={fields}
        limit={limit}
        onLimitChange={setLimit}
        collapseRepeats={collapseRepeats}
        onCollapseRepeatsChange={setCollapseRepeats}
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
      />

      <LogLegend
        containers={containers}
        colors={colors}
        counts={counts}
        hidden={hidden}
        failures={failures}
        onToggle={handleToggleContainer}
        onShowAll={handleShowAllContainers}
      />

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
      {failures.map((failure) => (
        <StreamFailureNotice
          key={failure.container}
          failure={failure}
          podName={podName}
          onRetry={retry}
        />
      ))}

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
  allHidden,
  onClearQuery,
  onShowAll,
}: {
  failed: boolean;
  connecting: boolean;
  streaming: boolean;
  retained: number;
  filtered: boolean;
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
          {formatCount(retained)} lines received.
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
