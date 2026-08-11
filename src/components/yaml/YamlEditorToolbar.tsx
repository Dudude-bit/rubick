import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { History, Copy, RotateCcw, AlignLeft, GitCompare } from "lucide-react";
import type { HistoryEntry } from "@/stores/yamlEditorStore";

export interface YamlEditorToolbarProps {
  // Which buttons to show
  showFormat?: boolean;
  showCopy?: boolean;
  showReset?: boolean;
  showDiff?: boolean;
  showHistory?: boolean;

  // State
  disabled?: boolean;
  hasChanges?: boolean;
  isDiffMode?: boolean;
  history?: HistoryEntry[];

  // Callbacks
  onFormat?: () => void;
  onCopy?: () => void;
  onReset?: () => void;
  onToggleDiff?: () => void;
  onRestoreHistory?: (timestamp: number) => void;
}

export function YamlEditorToolbar({
  showFormat = true,
  showCopy = true,
  showReset = true,
  showDiff = true,
  showHistory = true,
  disabled = false,
  hasChanges = false,
  isDiffMode = false,
  history = [],
  onFormat,
  onCopy,
  onReset,
  onToggleDiff,
  onRestoreHistory,
}: YamlEditorToolbarProps) {
  return (
    <div className="flex items-center gap-2">
      {showFormat && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onFormat}
              disabled={disabled}
            >
              <AlignLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Format YAML</TooltipContent>
        </Tooltip>
      )}

      {showCopy && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onCopy}
              disabled={disabled}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy to Clipboard</TooltipContent>
        </Tooltip>
      )}

      {showReset && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={onReset}
              disabled={disabled || !hasChanges}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset to Original</TooltipContent>
        </Tooltip>
      )}

      {showDiff && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={isDiffMode ? "secondary" : "outline"}
              size="sm"
              onClick={onToggleDiff}
              disabled={disabled}
            >
              <GitCompare className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle Diff View</TooltipContent>
        </Tooltip>
      )}

      {showHistory && history.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              <History className="mr-2 h-4 w-4" />
              History
              <Badge variant="secondary" className="ml-2">
                {history.length}
              </Badge>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel>Recent Changes</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {history.slice(0, 10).map((entry) => (
              <DropdownMenuItem
                key={entry.timestamp}
                onClick={() => onRestoreHistory?.(entry.timestamp)}
              >
                <div className="flex flex-col">
                  <span className="text-xs text-fg-mut">
                    {new Date(entry.timestamp).toLocaleString()}
                  </span>
                  {entry.label && (
                    <span className="text-sm">{entry.label}</span>
                  )}
                </div>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
