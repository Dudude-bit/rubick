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
} from "lucide-react";
import type { ViewMode } from "./types";

interface LogToolbarProps {
  containers: string[];
  selectedContainer: string;
  onContainerChange: (container: string) => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  tailLines: number;
  onTailLinesChange: (lines: number) => void;
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
  tailLines,
  onTailLinesChange,
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

      <Select
        value={tailLines.toString()}
        onValueChange={(v) => onTailLinesChange(parseInt(v))}
      >
        <SelectTrigger className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="100">100 lines</SelectItem>
          <SelectItem value="500">500 lines</SelectItem>
          <SelectItem value="1000">1000 lines</SelectItem>
          <SelectItem value="5000">5000 lines</SelectItem>
        </SelectContent>
      </Select>

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
