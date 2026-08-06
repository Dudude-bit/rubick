import { useState, useCallback, useMemo } from "react";
import { RefreshCw } from "lucide-react";
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
import { LogToolbar, ALL_CONTAINERS } from "./LogToolbar";
import { LogList } from "./LogList";
import { LogFilters } from "./LogFilters";
import { LogStatusBar } from "./LogStatusBar";
import { countCollapsed, expandRuns, groupConsecutive } from "./grouping";
import { logsToText, type ViewMode, type ActiveFilter } from "./types";

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
    <div className="space-y-1.5" aria-hidden="true" data-testid="log-skeleton">
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
      className="flex flex-none items-start justify-between gap-3 border-b border-hair px-4 py-2"
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
          <RefreshCw className="mr-2 h-3.5 w-3.5" />
          Reconnect
        </Button>
      )}
    </div>
  );
}

interface LogViewerProps {
  podName: string;
  namespace: string;
  containers: string[];
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
  // Every container by default: a sidecar bug is invisible one
  // container at a time, and the pane opening on one of five was the
  // reason the question could not be asked.
  const [selectedContainer, setSelectedContainer] = useState(
    initialContainer || ALL_CONTAINERS
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [limit, setLimit] = useState(DEFAULT_LOG_LIMIT);
  const [collapseRepeats, setCollapseRepeats] = useState(true);
  const [expandedRuns, setExpandedRuns] = useState<ReadonlySet<number>>(
    () => new Set()
  );
  const [viewMode, setViewMode] = useState<ViewMode>("compact");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);

  const streamedContainers =
    selectedContainer === ALL_CONTAINERS ? containers : [selectedContainer];

  const {
    logs,
    retained,
    dropped,
    isStreaming,
    isConnecting,
    failures,
    clearLogs,
    togglePause,
    retry,
  } = useLogStream({
    podName,
    namespace,
    containers: streamedContainers,
    limit,
  });

  // Filter logs based on search and active filters
  const filteredLogs = useMemo(() => {
    let result = logs;

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (log) =>
          log.message.toLowerCase().includes(query) ||
          log.raw.toLowerCase().includes(query)
      );
    }

    // Apply active filters
    for (const filter of activeFilters) {
      if (filter.type === "level") {
        result = result.filter((log) => log.level === filter.value);
      } else if (filter.type === "field" && filter.key) {
        result = result.filter(
          (log) => log.fields?.[filter.key!] === filter.value
        );
      }
    }

    return result;
  }, [logs, searchQuery, activeFilters]);

  // Grouping runs after filtering, so a filter that leaves two repeats
  // adjacent collapses them — the reader asked to see only these.
  const runs = useMemo(
    () => groupConsecutive(filteredLogs, collapseRepeats),
    [filteredLogs, collapseRepeats]
  );
  const rows = useMemo(
    () => expandRuns(filteredLogs, runs, expandedRuns),
    [filteredLogs, runs, expandedRuns]
  );
  const collapsedCount = useMemo(() => countCollapsed(runs), [runs]);

  const handleToggleRun = useCallback((id: number) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const handleAutoScrollToggle = useCallback(() => {
    // Turning it back on is the same act as jumping to the foot: the list
    // pins itself the moment `follow` flips true.
    setAutoScroll((previous) => !previous);
  }, []);

  const handleCopyLogs = useCallback(() => {
    if (filteredLogs.length === 0) return;
    copyToClipboard(
      logsToText(filteredLogs),
      `${filteredLogs.length} ${filteredLogs.length === 1 ? "line" : "lines"} copied`
    );
  }, [copyToClipboard, filteredLogs]);

  const handleDownloadLogs = async () => {
    // One container per file: `get_pod_logs` reads one container, and
    // interleaving several one-shot reads would invent an ordering the
    // API never gave.
    const container = streamedContainers[0];
    try {
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
      const a = document.createElement("a");
      a.href = url;
      a.download = `${podName}-${container}-logs.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download logs:", err);
      toast({
        title: "Download failed",
        description: "Could not download logs",
        variant: "destructive",
      });
    }
  };

  const handleFieldClick = (key: string, value: string) => {
    const exists = activeFilters.some(
      (f) => f.type === "field" && f.key === key && f.value === value
    );
    if (!exists) {
      setActiveFilters((prev) => [
        ...prev,
        { type: "field", key, value, label: `${key}=${value}` },
      ]);
    }
  };

  const handleLevelClick = (level: string) => {
    const exists = activeFilters.some(
      (f) => f.type === "level" && f.value === level
    );
    if (!exists) {
      setActiveFilters((prev) => [
        ...prev,
        { type: "level", value: level, label: `level=${level}` },
      ]);
    }
  };

  const handleRemoveFilter = (filter: ActiveFilter) => {
    setActiveFilters((prev) =>
      prev.filter(
        (f) =>
          !(
            f.type === filter.type &&
            f.key === filter.key &&
            f.value === filter.value
          )
      )
    );
  };

  const handleRetry = () => {
    retry();
  };

  return (
    <div className="flex flex-col h-full">
      <LogToolbar
        containers={containers}
        selectedContainer={selectedContainer}
        onContainerChange={setSelectedContainer}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        limit={limit}
        onLimitChange={setLimit}
        collapseRepeats={collapseRepeats}
        onCollapseRepeatsChange={setCollapseRepeats}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isStreaming={isStreaming}
        isConnecting={isConnecting}
        autoScroll={autoScroll}
        isAtBottom={isAtBottom}
        onAutoScrollToggle={handleAutoScrollToggle}
        onClearLogs={clearLogs}
        onCopyLogs={handleCopyLogs}
        onDownloadLogs={handleDownloadLogs}
        onToggleStreaming={togglePause}
      />

      <LogFilters filters={activeFilters} onRemoveFilter={handleRemoveFilter} />

      {/* One notice per container whose stream died. Four containers can
          still be streaming while the fifth is gone, and a single verdict
          could not say which. */}
      {failures.map((failure) => (
        <StreamFailureNotice
          key={failure.container}
          failure={failure}
          podName={podName}
          onRetry={handleRetry}
        />
      ))}

      <LogList
        logs={filteredLogs}
        rows={rows}
        expandedRuns={expandedRuns}
        onToggleRun={handleToggleRun}
        viewMode={viewMode}
        searchQuery={searchQuery}
        follow={autoScroll}
        atBottom={isAtBottom}
        onFollowChange={setAutoScroll}
        onAtBottomChange={setIsAtBottom}
        resetKey={selectedContainer}
        oldestRetainedId={logs[0]?.id}
        onFieldClick={handleFieldClick}
        onLevelClick={handleLevelClick}
      >
        {failures.length > 0 && logs.length === 0 ? null : isConnecting &&
          logs.length === 0 ? (
          // Lines, not a spinner: the shape the output will take says "this
          // is a log about to arrive" where a spinner says only "wait".
          <LogSkeleton />
        ) : (
          <div className="py-8 text-center text-xs text-fg-mut">
            {logs.length > 0 ? (
              <>
                No line matches the current filter.
                <span className="text-fg-fnt"> {logs.length} received.</span>
              </>
            ) : isStreaming ? (
              <>
                No output yet.
                {/* Safe to claim the stream is attached now: a stream that
                    dies emits `stream-failed`, which replaces this with the
                    notice above. Before that event existed this branch also
                    covered a broken connection and could not say so. */}
                <span className="text-fg-fnt">
                  {" "}
                  The stream is attached; this container has written nothing
                  since it started.
                </span>
              </>
            ) : (
              'Not streaming. Press "Stream" to attach.'
            )}
          </div>
        )}
      </LogList>

      {/* The status bar carries the live indicator: a pulsing dot beside the
          word "Streaming", which is the only thing that separates an attached
          stream from a dead pane. */}
      <LogStatusBar
        logs={logs}
        retained={retained}
        limit={limit}
        dropped={dropped}
        filteredCount={filteredLogs.length}
        collapsedCount={collapsedCount}
        isStreaming={isStreaming}
      />
    </div>
  );
}
