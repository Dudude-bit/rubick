import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  ArrowDown,
  Copy,
  Download,
  MoreHorizontal,
  Trash2,
} from "lucide-react";

import type { FieldIndex } from "./hooks/log-buffer";
import { LOG_LIMITS } from "./hooks/useLogStream";
import { LogQuery } from "./LogQuery";
import { formatCount, type QueryTerm, type ViewMode } from "./types";

const VIEW_MODES: Array<{ mode: ViewMode; label: string; hint: string }> = [
  {
    mode: "compact",
    label: "Compact",
    hint: "One line per entry, fields inline",
  },
  {
    mode: "table",
    label: "Table",
    hint: "Level spelled out and the message wrapped in full",
  },
  { mode: "raw", label: "Raw", hint: "The bytes the container wrote" },
];

interface LogToolbarProps {
  terms: QueryTerm[];
  draft: string;
  onDraftChange: (draft: string) => void;
  onAddTerm: (term: QueryTerm) => void;
  onRemoveTerm: (term: QueryTerm) => void;
  /** Labels of the terms kept at the source rather than over the buffer. */
  intake: ReadonlySet<string>;
  onToggleIntake: (term: QueryTerm) => void;
  /** What the buffer can be filtered by, offered when the query is focused. */
  fields: FieldIndex;
  /** Backfill and retention in one number — see `DEFAULT_LOG_LIMIT`. */
  limit: number;
  onLimitChange: (limit: number) => void;
  collapseRepeats: boolean;
  onCollapseRepeatsChange: (collapse: boolean) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  isStreaming: boolean;
  isConnecting: boolean;
  /** Stopped by the reader, as opposed to stopped because the stream died. */
  isPaused: boolean;
  autoScroll: boolean;
  isAtBottom: boolean;
  onAutoScrollToggle: () => void;
  onClearLogs: () => void;
  onCopyLogs: () => void;
  onDownloadLogs: () => void;
  onToggleStreaming: () => void;
}

/**
 * Every control says what it is.
 *
 * This was five unlabelled icon buttons, which is not a toolbar so much
 * as a quiz: an icon-only control whose meaning you discover by clicking
 * it is not a control. The three that are modes — the view, the collapse,
 * the follow — carry their word on screen because their state has to be
 * readable at a glance; the three that are one-shot actions live behind a
 * named menu, which is also what keeps this from wrapping to three rows
 * in a 360px peek panel.
 */
export function LogToolbar({
  terms,
  draft,
  onDraftChange,
  onAddTerm,
  onRemoveTerm,
  intake,
  onToggleIntake,
  fields,
  limit,
  onLimitChange,
  collapseRepeats,
  onCollapseRepeatsChange,
  viewMode,
  onViewModeChange,
  isStreaming,
  isConnecting,
  isPaused,
  autoScroll,
  isAtBottom,
  onAutoScrollToggle,
  onClearLogs,
  onCopyLogs,
  onDownloadLogs,
  onToggleStreaming,
}: LogToolbarProps) {
  return (
    // Wraps because the same toolbar sits in the peek panel, which the
    // reader can drag down to 360px — unwrapped it pushed its own controls
    // off the edge.
    //
    // Everything in it is 24px tall, borders included: that is the rhythm
    // the tables already keep, and this row used to hold three heights at
    // once — a 30px query box, 24px buttons and a 22px segment group.
    <div className="flex flex-wrap items-center gap-1.5 border-b border-hair px-2 py-1.5">
      <LogQuery
        terms={terms}
        draft={draft}
        onDraftChange={onDraftChange}
        onAddTerm={onAddTerm}
        onRemoveTerm={onRemoveTerm}
        intake={intake}
        onToggleIntake={onToggleIntake}
        fields={fields}
      />

      <div className="flex h-6 items-center gap-px rounded-md border border-hair p-px">
        {VIEW_MODES.map(({ mode, label, hint }) => (
          <button
            key={mode}
            type="button"
            title={hint}
            aria-pressed={viewMode === mode}
            onClick={() => onViewModeChange(mode)}
            className={`flex h-full items-center rounded px-2 text-xs ${
              viewMode === mode
                ? "bg-sel text-fg"
                : "text-fg-mut hover:bg-hover hover:text-fg"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <ToolbarToggle
        on={collapseRepeats}
        onClick={() => onCollapseRepeatsChange(!collapseRepeats)}
        title="Collapse consecutive repeats into one row with a count and a time span"
      >
        Repeats
      </ToolbarToggle>

      <ToolbarToggle
        on={autoScroll}
        onClick={onAutoScrollToggle}
        title={
          autoScroll
            ? "Following the tail — click to stop and read"
            : "Jump to the newest line and follow it"
        }
      >
        <ArrowDown
          aria-hidden="true"
          className={`h-3 w-3 ${!isAtBottom && !autoScroll ? "animate-bounce" : ""}`}
        />
        Follow
      </ToolbarToggle>

      {/* One number, one meaning: it is what the stream backfills with
          and what the viewer keeps. It used to be two, and only the
          smaller one was on screen. */}
      <Select
        value={limit.toString()}
        onValueChange={(value) => onLimitChange(parseInt(value))}
      >
        <SelectTrigger
          className="h-6 w-[6.5rem] px-2 text-xs"
          title="How many lines to backfill and then keep"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LOG_LIMITS.map((option) => (
            <SelectItem key={option} value={option.toString()}>
              Keep {formatCount(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggleStreaming}
          disabled={isConnecting}
          title={
            isStreaming
              ? "Stop reading from the container"
              : "Attach to the container and follow its output"
          }
          className="flex h-6 items-center gap-1.5 rounded bg-sel px-2 text-xs text-fg hover:bg-hover disabled:opacity-60"
        >
          {isConnecting ? (
            <>
              <Spinner size="sm" />
              Connecting
            </>
          ) : (
            <>
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${
                  isStreaming ? "animate-pulse bg-ok" : "bg-fg-fnt"
                }`}
              />
              {/* Three states, not two: a stream the reader stopped and a
                  stream that died are both "not live", and calling the
                  second one "Paused" blames the reader for it. */}
              {isStreaming ? "Live" : isPaused ? "Paused" : "Stopped"}
            </>
          )}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger
            title="More log actions"
            aria-label="More log actions"
            className="flex h-6 w-6 items-center justify-center rounded text-fg-mut hover:bg-hover hover:text-fg"
          >
            <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Copy is a menu item rather than ctrl+A because the list is
                virtualised: only a screenful is ever in the DOM, so this is
                the one path guaranteed to yield every retained line. */}
            <DropdownMenuItem onSelect={onCopyLogs}>
              <Copy aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
              Copy the lines in view
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDownloadLogs}>
              <Download aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
              Download the full log
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onClearLogs}>
              <Trash2 aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
              Clear what is buffered
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ToolbarToggle({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`flex h-6 items-center gap-1 rounded px-2 text-xs ${
        on ? "bg-sel text-fg" : "text-fg-mut hover:bg-hover hover:text-fg"
      }`}
    >
      {children}
      <span aria-hidden="true" className={on ? "text-fg-mut" : "opacity-0"}>
        ✓
      </span>
    </button>
  );
}
