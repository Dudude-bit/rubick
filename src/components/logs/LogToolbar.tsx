import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Copy,
  Download,
  Pause,
  Play,
  Search,
  Trash2,
  ArrowDown,
  Rows3,
  AlignJustify,
  Code,
  Layers,
} from "lucide-react";
import { LOG_LIMITS } from "./hooks/useLogStream";
import type { ViewMode } from "./types";

/**
 * The default selection: every container streamed at once. A sentinel
 * rather than an empty string because Radix's Select treats "" as
 * "nothing chosen" and shows the placeholder.
 */
export const ALL_CONTAINERS = "__all__";

interface LogToolbarProps {
  containers: string[];
  selectedContainer: string;
  onContainerChange: (container: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /** Backfill and retention in one number — see `DEFAULT_LOG_LIMIT`. */
  limit: number;
  onLimitChange: (limit: number) => void;
  collapseRepeats: boolean;
  onCollapseRepeatsChange: (collapse: boolean) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  isStreaming: boolean;
  isConnecting: boolean;
  autoScroll: boolean;
  isAtBottom: boolean;
  onAutoScrollToggle: () => void;
  onClearLogs: () => void;
  onCopyLogs: () => void;
  onDownloadLogs: () => void;
  onToggleStreaming: () => void;
}

export function LogToolbar({
  containers,
  selectedContainer,
  onContainerChange,
  searchQuery,
  onSearchChange,
  limit,
  onLimitChange,
  collapseRepeats,
  onCollapseRepeatsChange,
  viewMode,
  onViewModeChange,
  isStreaming,
  isConnecting,
  autoScroll,
  isAtBottom,
  onAutoScrollToggle,
  onClearLogs,
  onCopyLogs,
  onDownloadLogs,
  onToggleStreaming,
}: LogToolbarProps) {
  return (
    // Wraps because the same toolbar now sits in the peek panel, which the
    // reader can drag down to 360px — unwrapped it pushed its own controls
    // off the edge.
    <div className="flex flex-wrap items-center gap-2 border-b border-hair p-2">
      <Select value={selectedContainer} onValueChange={onContainerChange}>
        <SelectTrigger className="w-48">
          <SelectValue placeholder="Select container" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_CONTAINERS}>
            All containers ({containers.length})
          </SelectItem>
          {containers.map((container) => (
            <SelectItem key={container} value={container}>
              {container}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="relative flex-1 max-w-xs">
        <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-fg-fnt" />
        <Input
          placeholder="Search logs..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8"
        />
      </div>

      {/* One number, one meaning: it is what the stream backfills with
          and what the viewer keeps. It used to be two, and only the
          smaller one was on screen. */}
      <Select
        value={limit.toString()}
        onValueChange={(v) => onLimitChange(parseInt(v))}
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LOG_LIMITS.map((option) => (
            <SelectItem key={option} value={option.toString()}>
              Keep {option.toLocaleString()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        variant={collapseRepeats ? "secondary" : "ghost"}
        size="sm"
        onClick={() => onCollapseRepeatsChange(!collapseRepeats)}
        title="Collapse consecutive repeats into one row with a count"
      >
        <Layers className="mr-1 h-4 w-4" />
        Repeats
      </Button>

      <div className="flex items-center border rounded-md">
        <Button
          variant={viewMode === "compact" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("compact")}
          title="Compact view"
          className="rounded-r-none"
        >
          <AlignJustify className="h-4 w-4" />
        </Button>
        <Button
          variant={viewMode === "table" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("table")}
          title="Table view"
          className="rounded-none border-x"
        >
          <Rows3 className="h-4 w-4" />
        </Button>
        <Button
          variant={viewMode === "raw" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => onViewModeChange("raw")}
          title="Raw view"
          className="rounded-l-none"
        >
          <Code className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex items-center gap-1 ml-auto">
        <Button
          variant={autoScroll ? "secondary" : "ghost"}
          size="icon"
          onClick={onAutoScrollToggle}
          title={
            autoScroll
              ? "Auto-scroll enabled (click to disable)"
              : "Enable auto-scroll"
          }
        >
          <ArrowDown
            className={`h-4 w-4 ${!isAtBottom && !autoScroll ? "animate-bounce" : ""}`}
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClearLogs}
          title="Clear logs"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        {/* Copy is a button rather than ctrl+A because the list is
            virtualised: only a screenful is ever in the DOM, so this is the
            one path guaranteed to yield every retained line. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={onCopyLogs}
          title="Copy all retained lines"
        >
          <Copy className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDownloadLogs}
          title="Download logs"
        >
          <Download className="h-4 w-4" />
        </Button>
        <Button
          variant={isStreaming ? "destructive" : "default"}
          size="sm"
          onClick={onToggleStreaming}
          disabled={isConnecting}
        >
          {isConnecting ? (
            <>
              <Spinner size="sm" className="mr-1" />
              Connecting
            </>
          ) : isStreaming ? (
            <>
              <Pause className="h-4 w-4 mr-1" />
              Stop
            </>
          ) : (
            <>
              <Play className="h-4 w-4 mr-1" />
              Stream
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
