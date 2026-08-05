import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { commands } from "@/lib/commands";

import { useLogStream } from "./hooks/useLogStream";
import { LogToolbar } from "./LogToolbar";
import { LogLineComponent } from "./LogLine";
import { LogFilters } from "./LogFilters";
import { LogStatusBar } from "./LogStatusBar";
import type { ViewMode, ActiveFilter } from "./types";

interface LogViewerProps {
  podName: string;
  namespace: string;
  containers: string[];
  initialContainer?: string;
  onPodNotFound?: () => void;
}

export function LogViewer({
  podName,
  namespace,
  containers,
  initialContainer,
  onPodNotFound,
}: LogViewerProps) {
  const { toast } = useToast();
  const [selectedContainer, setSelectedContainer] = useState(
    initialContainer || containers[0]
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [tailLines, setTailLines] = useState(100);
  const [viewMode, setViewMode] = useState<ViewMode>("compact");
  const [autoScroll, setAutoScroll] = useState(true);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const scrollAreaRef = useRef<HTMLDivElement>(null);

  const {
    logs,
    isStreaming,
    isConnecting,
    error,
    clearLogs,
    togglePause,
    retry,
  } = useLogStream({
    podName,
    namespace,
    container: selectedContainer,
    tailLines,
    onPodNotFound,
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

  // Scroll area helpers
  const getViewport = useCallback(() => {
    return scrollAreaRef.current?.querySelector(
      "[data-radix-scroll-area-viewport]"
    ) as HTMLElement | null;
  }, []);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && filteredLogs.length > 0) {
      const viewport = getViewport();
      if (viewport) {
        // Double rAF to ensure DOM is updated before scrolling
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            viewport.scrollTop = viewport.scrollHeight;
          });
        });
      }
    }
  }, [filteredLogs, autoScroll, getViewport]);

  // Track scroll position
  useEffect(() => {
    const viewport = getViewport();
    if (!viewport) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const atBottom = scrollHeight - scrollTop - clientHeight < 50;
      setIsAtBottom(atBottom);

      if (atBottom && !autoScroll) {
        setAutoScroll(true);
      }
      if (!atBottom && autoScroll) {
        setAutoScroll(false);
      }
    };

    viewport.addEventListener("scroll", handleScroll);
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, [autoScroll, getViewport]);

  const handleAutoScrollToggle = useCallback(() => {
    if (autoScroll) {
      // Disable auto-scroll
      setAutoScroll(false);
    } else {
      // Enable auto-scroll and scroll to bottom
      const viewport = getViewport();
      if (viewport) {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: "smooth",
        });
      }
      setAutoScroll(true);
    }
  }, [autoScroll, getViewport]);

  const handleDownloadLogs = async () => {
    try {
      const allLogs = await commands.getPodLogs(
        podName,
        namespace,
        selectedContainer,
        10000,
        null,
        false
      );

      const content = allLogs
        .map((log) => log.raw || `${log.timestamp || ""} ${log.message}`)
        .join("\n");
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${podName}-${selectedContainer}-logs.txt`;
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
        tailLines={tailLines}
        onTailLinesChange={setTailLines}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        isStreaming={isStreaming}
        isConnecting={isConnecting}
        autoScroll={autoScroll}
        isAtBottom={isAtBottom}
        onAutoScrollToggle={handleAutoScrollToggle}
        onClearLogs={clearLogs}
        onDownloadLogs={handleDownloadLogs}
        onToggleStreaming={togglePause}
      />

      <LogFilters filters={activeFilters} onRemoveFilter={handleRemoveFilter} />

      <ScrollArea className="flex-1" ref={scrollAreaRef}>
        <div
          className="p-4 font-mono text-xs leading-relaxed"
          style={{ minHeight: "100%" }}
        >
          {error ? (
            <div className="text-center py-8">
              <p className="mb-2 text-err">Failed to stream logs</p>
              <p className="mb-4 text-xs text-fg-mut">{error}</p>
              <Button variant="outline" size="sm" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="py-8 text-center text-fg-mut">
              {isConnecting
                ? "Connecting to log stream..."
                : isStreaming
                  ? "Waiting for logs..."
                  : 'Click "Stream" to start viewing logs'}
            </div>
          ) : (
            filteredLogs.map((log) => (
              <LogLineComponent
                key={log.id}
                log={log}
                viewMode={viewMode}
                searchQuery={searchQuery}
                onFieldClick={handleFieldClick}
                onLevelClick={handleLevelClick}
              />
            ))
          )}
        </div>
      </ScrollArea>

      <LogStatusBar
        logs={logs}
        filteredCount={filteredLogs.length}
        isStreaming={isStreaming}
        searchQuery={searchQuery}
      />
    </div>
  );
}
