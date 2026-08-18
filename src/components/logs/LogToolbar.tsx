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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { DensityStripMode } from "@/stores/displaySettingsStore";
import { Spinner } from "@/components/ui/spinner";
import {
  ArrowDown,
  Copy,
  Download,
  History,
  MoreHorizontal,
  Trash2,
} from "lucide-react";

import type { FieldIndex } from "./hooks/log-buffer";
import { LOG_LIMITS } from "./hooks/useLogStream";
import { LogQuery } from "./LogQuery";
import { formatCount, type QueryTerm, type ViewMode } from "./types";
import { useT } from "@/i18n/useT";
import type { en } from "@/i18n/catalogue";

const STRIP_MODES: Array<{
  mode: DensityStripMode;
  label: keyof typeof en.action;
  hint: keyof typeof en.action;
}> = [
  {
    mode: "full",
    label: "stripFull",
    hint: "stripFullHint",
  },
  {
    mode: "band",
    label: "stripBand",
    hint: "stripBandHint",
  },
  {
    mode: "off",
    label: "stripHidden",
    hint: "stripHiddenHint",
  },
];

const VIEW_MODES: Array<{
  mode: ViewMode;
  label: keyof typeof en.action;
  hint: keyof typeof en.action;
}> = [
  {
    mode: "compact",
    label: "viewCompact",
    hint: "viewCompactHint",
  },
  {
    mode: "table",
    label: "viewTable",
    hint: "viewTableHint",
  },
  { mode: "raw", label: "viewRaw", hint: "viewRawHint" },
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
  /**
   * Reading the run before the current one, and whether there is one to
   * read. A container's `lastTerminated` is set for exactly the runs the
   * apiserver will still serve with `--previous`, so the control is
   * offered only where it can answer — an always-present toggle whose
   * only reply is "there is nothing earlier" is not a control.
   */
  previousRun: boolean;
  offerPreviousRun: boolean;
  onPreviousRunToggle: () => void;
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
  /** How much of the density strip is drawn, hidden included. */
  stripMode: DensityStripMode;
  onStripModeChange: (mode: DensityStripMode) => void;
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
  previousRun,
  offerPreviousRun,
  onPreviousRunToggle,
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
  stripMode,
  onStripModeChange,
}: LogToolbarProps) {
  const t = useT();

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
            title={t("action", hint)}
            aria-pressed={viewMode === mode}
            onClick={() => onViewModeChange(mode)}
            className={`flex h-full items-center rounded px-2 text-xs ${
              viewMode === mode
                ? "bg-sel text-fg"
                : "text-fg-mut hover:bg-hover hover:text-fg"
            }`}
          >
            {t("action", label)}
          </button>
        ))}
      </div>

      <ToolbarToggle
        on={collapseRepeats}
        onClick={() => onCollapseRepeatsChange(!collapseRepeats)}
        title={t("action", "collapseRepeatsHint")}
      >
        {t("action", "repeats")}
      </ToolbarToggle>

      {offerPreviousRun && (
        <ToolbarToggle
          on={previousRun}
          onClick={onPreviousRunToggle}
          title={
            previousRun
              ? t("action", "previousRunOnHint")
              : t("action", "previousRunOffHint")
          }
        >
          <History aria-hidden="true" className="h-3 w-3" />
          {t("action", "previousRun")}
        </ToolbarToggle>
      )}

      <ToolbarToggle
        on={autoScroll}
        onClick={onAutoScrollToggle}
        title={
          autoScroll
            ? t("action", "followOnHint")
            : t("action", "followOffHint")
        }
      >
        <ArrowDown
          aria-hidden="true"
          className={`h-3 w-3 ${!isAtBottom && !autoScroll ? "animate-bounce" : ""}`}
        />
        {t("action", "follow")}
      </ToolbarToggle>

      {/* One number, one meaning: it is what the stream backfills with
          and what the viewer keeps. It used to be two, and only the
          smaller one was on screen. */}
      <Select
        value={limit.toString()}
        onValueChange={(value) => onLimitChange(parseInt(value))}
      >
        <SelectTrigger
          className="h-6 w-26 px-2 text-xs"
          title={t("action", "keepLinesHint")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LOG_LIMITS.map((option) => (
            <SelectItem key={option} value={option.toString()}>
              {t("action", "keepLines", { n: formatCount(option) })}
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
              ? t("action", "stopStreamHint")
              : t("action", "startStreamHint")
          }
          className="flex h-6 items-center gap-1.5 rounded bg-sel px-2 text-xs text-fg hover:bg-hover disabled:opacity-60"
        >
          {isConnecting ? (
            <>
              <Spinner size="sm" />
              {t("action", "connecting")}
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
              {isStreaming
                ? t("action", "streamLive")
                : isPaused
                  ? t("action", "streamPaused")
                  : t("action", "streamStopped")}
            </>
          )}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger
            title={t("action", "moreLogActions")}
            aria-label={t("action", "moreLogActions")}
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
              {t("action", "copyLinesInView")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDownloadLogs}>
              <Download aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
              {t("action", "downloadFullLog")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onClearLogs}>
              <Trash2 aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
              {t("action", "clearBuffered")}
            </DropdownMenuItem>

            {/* Hiding the strip outright is only reachable from here, and so
                is undoing it: a control that removes itself would leave the
                reader nothing to click to get the map back. */}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("action", "densityStrip")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={stripMode}
              onValueChange={(value) =>
                onStripModeChange(value as DensityStripMode)
              }
            >
              {STRIP_MODES.map(({ mode, label, hint }) => (
                <DropdownMenuRadioItem
                  key={mode}
                  value={mode}
                  title={t("action", hint)}
                >
                  {t("action", label)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
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
