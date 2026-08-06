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
import { LogStatusBar } from "./LogStatusBar";
import { containerColors as buildContainerColors } from "./container-colors";
import { countCollapsed, expandRuns, groupConsecutive } from "./grouping";
import {
  formatCount,
  logsToText,
  matchesQuery,
  termLabel,
  type QueryTerm,
  type ViewMode,
} from "./types";

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

  const {
    logs,
    retained,
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
  // container does not zero the number that says how loud it is.
  const counts = useMemo(() => {
    const byContainer = new Map<string, number>();
    for (const log of logs) {
      byContainer.set(log.container, (byContainer.get(log.container) ?? 0) + 1);
    }
    return byContainer;
  }, [logs]);

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

  const visibleLogs = useMemo(
    () =>
      logs.filter(
        (log) => !hidden.has(log.container) && matchesQuery(log, effectiveTerms)
      ),
    [logs, hidden, effectiveTerms]
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

  const handleFieldClick = useCallback(
    (key: string, value: string) => {
      handleAddTerm({ kind: "field", key, op: "=", value });
    },
    [handleAddTerm]
  );

  const handleLevelClick = useCallback(
    (level: LogLevel) => {
      handleAddTerm({ kind: "level", op: "=", value: level });
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
      <LogToolbar
        terms={terms}
        draft={draft}
        onDraftChange={setDraft}
        onAddTerm={handleAddTerm}
        onRemoveTerm={handleRemoveTerm}
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

/** Add or drop one member, without mutating the set the render read. */
function toggled<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}
