import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { LogLevel } from "@/generated/types";
import { ArrowDown } from "lucide-react";

import { LogLineComponent, LogRunRow } from "./LogLine";
import type { LogRun } from "./grouping";
import { logsToText, type StreamedLogLine, type ViewMode } from "./types";

/**
 * The output itself, windowed.
 *
 * Lives apart from `LogViewer` for one blunt reason: `useVirtualizer` hands
 * back functions the React Compiler refuses to memoize, so any component
 * holding it is skipped wholesale. Keeping it here means the toolbar, the
 * filters and the status bar are still compiled.
 */

/**
 * How close to the foot still counts as "at the bottom". Generous on
 * purpose: the follow has to survive the last row growing by a line as it
 * is measured, and a reader nudging the wheel by one notch.
 */
const BOTTOM_SLACK_PX = 48;

/**
 * A one-line compact row. Only a starting guess — every row that renders is
 * measured for real, because a row with its detail open is a dozen lines
 * tall and a wrapped Table row in a 360px peek panel can be five.
 */
const ESTIMATED_ROW_PX = 19;

interface LogListProps {
  /** Already filtered; the source the rows index into, and what a copy yields. */
  logs: StreamedLogLine[];
  /**
   * One per row. A run of 1 is an ordinary line; anything above that is
   * a collapsed repeat. Rows rather than lines because the count the
   * virtualiser needs is the count of things drawn.
   */
  rows: LogRun[];
  expandedRuns: ReadonlySet<number>;
  onToggleRun: (id: number) => void;
  /** Lines showing their detail block. Measured like any other height change. */
  expandedLines: ReadonlySet<number>;
  onToggleLine: (id: number) => void;
  /** Container name -> its rule colour, for the whole pod. */
  containerColors: Map<string, string>;
  viewMode: ViewMode;
  searchQuery: string;
  follow: boolean;
  /** Owned by the parent (the toolbar reads it too), reported back up below. */
  atBottom: boolean;
  onFollowChange: (follow: boolean) => void;
  onAtBottomChange: (atBottom: boolean) => void;
  /** A new value scrolls back to the top: a new container is a new log. */
  resetKey: string;
  /**
   * Oldest line still retained upstream. Measured heights are cached by line
   * id and TanStack never evicts them, so a stream left running would keep
   * one entry per line it ever drew; ids are monotonic, so anything below
   * this is dead.
   */
  oldestRetainedId: number | undefined;
  /**
   * The stretch of wall clock on screen right now, so the density strip
   * can mark where the reader is. Reported as two numbers rather than a
   * range object: the parent holds them as state and an unchanged number
   * costs nothing, where a fresh object would re-render on every batch.
   */
  onViewportRangeChange?: (from: number, to: number) => void;
  /**
   * A row to scroll to. A new object is a new request — the strip hands
   * one over on every click, including a second click on the same slice.
   */
  scrollTarget?: { index: number } | null;
  onFieldClick: (key: string, value: string) => void;
  onLevelClick: (level: LogLevel) => void;
  /** Shown in place of the list when there is nothing to window. */
  children?: ReactNode;
}

export function LogList({
  logs,
  rows,
  expandedRuns,
  onToggleRun,
  expandedLines,
  onToggleLine,
  containerColors,
  viewMode,
  searchQuery,
  follow,
  atBottom,
  onFollowChange,
  onAtBottomChange,
  resetKey,
  oldestRetainedId,
  onViewportRangeChange,
  scrollTarget,
  onFieldClick,
  onLevelClick,
  children,
}: LogListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [viewportPx, setViewportPx] = useState(0);

  // The compiler cannot memoize a virtualizer and so skips whatever component
  // holds one. That skip is the reason this file exists separately from
  // LogViewer, and it stops here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    // Height is cached per line, not per position, so filtering — which
    // reshuffles every index — never hands a row someone else's height.
    getItemKey: (index) => rows[index].id,
    overscan: 16,
    // Once the buffer is full every batch drops lines off the head. Without
    // an end anchor that shifts everything under a reader who has scrolled
    // up, several times a second.
    anchorTo: "end",
    scrollEndThreshold: BOTTOM_SLACK_PX,
    // Measuring a row inside the ResizeObserver callback that reported it
    // resizes the list, which re-enters the observer: WebKit answers that
    // with "ResizeObserver loop completed with undelivered notifications"
    // once per batch, and the app turns window errors into toasts. A frame's
    // delay costs nothing here — the follow re-pins when the total changes.
    useAnimationFrameWithResizeObserver: true,
  });

  const totalSize = virtualizer.getTotalSize();

  /**
   * Follow the tail. Runs on every batch (a batch is a fresh array) and again
   * whenever measurement corrects the total height, which is what keeps the
   * view pinned while rows resolve from estimate to real height.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (follow && rows.length > 0) {
      el.scrollTop = el.scrollHeight;
      onAtBottomChange(true);
      return;
    }
    // Not following: the tail growing below the fold is what puts the reader
    // out of sight of it, and no scroll event fires for that.
    onAtBottomChange(
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
    );
  }, [follow, rows, totalSize, onAtBottomChange]);

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget;
      const atBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX;
      onAtBottomChange(atBottom);
      // Scrolling up stops the follow; scrolling back to the foot re-arms it.
      onFollowChange(atBottom);
    },
    [onAtBottomChange, onFollowChange]
  );

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    // Instant, not smooth: a smooth scroll to an offset that is still half
    // estimate lands somewhere else by the time it arrives.
    if (el) el.scrollTop = el.scrollHeight;
    onFollowChange(true);
    onAtBottomChange(true);
  }, [onAtBottomChange, onFollowChange]);

  /**
   * A row's height depends on the view mode, on the `<mark>` spans the search
   * injects, and on how wide the panel is — the peek is draggable down to
   * 360px. Any of those changes every cached height at once, and keeping them
   * would draw rows on top of each other.
   */
  useEffect(() => {
    virtualizer.measure();
  }, [viewMode, searchQuery, virtualizer]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let width = el.clientWidth;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      // Height is not a reason to re-measure rows, but it is what decides
      // which of them are actually on screen — see the viewport range below.
      setViewportPx(el.clientHeight);
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Out of the observer callback for the same reason as above: dropping
      // every cached height relays out the list the observer just reported.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => virtualizer.measure());
    });
    observer.observe(el);
    setViewportPx(el.clientHeight);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [virtualizer]);

  /**
   * A container switch restarts the stream and empties the buffer. The
   * viewport has to go back to the top and the follow has to be re-armed, or
   * the new container opens parked at the old one's offset.
   */
  useEffect(() => {
    virtualizer.measure();
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
    onFollowChange(true);
    onAtBottomChange(true);
  }, [resetKey, virtualizer, onAtBottomChange, onFollowChange]);

  /**
   * Which rows are genuinely on screen, and therefore what stretch of
   * clock the strip should mark.
   *
   * The rendered window is deliberately wider than the viewport — sixteen
   * rows of overscan at each end — so reporting what is rendered would
   * mark a slice the reader cannot see. Intersecting against the scroll
   * offset is the only reading that matches what is in front of them.
   */
  const items = virtualizer.getVirtualItems();
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  let firstVisible = -1;
  let lastVisible = -1;
  for (const item of items) {
    if (item.end <= scrollOffset || item.start >= scrollOffset + viewportPx) {
      continue;
    }
    if (firstVisible < 0) firstVisible = item.index;
    lastVisible = item.index;
  }
  const viewFrom = firstVisible >= 0 ? rows[firstVisible].head.epoch : 0;
  const viewTo = lastVisible >= 0 ? rows[lastVisible].tail.epoch : 0;

  useEffect(() => {
    onViewportRangeChange?.(viewFrom, viewTo);
  }, [viewFrom, viewTo, onViewportRangeChange]);

  /**
   * A click on the strip lands here. The follow is already off by the
   * time this runs — the parent turns it off in the same update — so the
   * scroll is not undone by the next batch pinning the tail.
   */
  useEffect(() => {
    if (!scrollTarget) return;
    virtualizer.scrollToIndex(scrollTarget.index, { align: "start" });
  }, [scrollTarget, virtualizer]);

  useEffect(() => {
    const cache = virtualizer.itemSizeCache;
    if (oldestRetainedId === undefined || cache.size <= rows.length * 2) return;
    for (const key of cache.keys()) {
      if (typeof key === "number" && key < oldestRetainedId) cache.delete(key);
    }
  }, [oldestRetainedId, rows.length, virtualizer]);

  /**
   * Select-all over a virtualised list is a trap: the DOM holds a screenful,
   * so the browser would hand over forty lines out of forty thousand and look
   * like it worked. Ctrl+A selects the rendered window, so there is still
   * something visible to copy...
   */
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "a") {
      return;
    }
    const list = listRef.current;
    const selection = window.getSelection();
    if (!list || !selection) return;
    event.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(list);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  /**
   * ...and a copy that swallows the whole rendered window is answered with
   * the whole retained buffer instead. A partial selection is left alone —
   * that one the DOM can answer honestly by itself.
   */
  const handleCopy = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const list = listRef.current;
      const selection = window.getSelection();
      if (!list || !selection || selection.rangeCount === 0) return;
      if (selection.isCollapsed || logs.length === 0) return;

      const selected = selection.getRangeAt(0);
      const whole = document.createRange();
      whole.selectNodeContents(list);
      const swallowsList =
        selected.compareBoundaryPoints(Range.START_TO_START, whole) <= 0 &&
        selected.compareBoundaryPoints(Range.END_TO_END, whole) >= 0;
      if (!swallowsList) return;

      event.preventDefault();
      event.clipboardData.setData("text/plain", logsToText(logs));
    },
    [logs]
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        // Focusable so ctrl+A lands here rather than on the document.
        tabIndex={0}
        data-testid="log-scroll"
        className="h-full overflow-y-auto scrollbar-thin px-1 py-1.5 font-mono text-xs leading-[1.45] outline-none focus-visible:ring-1 focus-visible:ring-hair"
      >
        {rows.length === 0 ? (
          children
        ) : (
          <div
            ref={listRef}
            data-log-list
            className="relative w-full"
            style={{ height: totalSize }}
          >
            {items.map((item) => {
              const run = rows[item.index];
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {run.count > 1 ? (
                    <LogRunRow
                      run={run}
                      expanded={expandedRuns.has(run.id)}
                      containerColor={containerColors.get(run.head.container)}
                      onToggle={onToggleRun}
                    />
                  ) : (
                    <LogLineComponent
                      log={run.head}
                      lineId={run.id}
                      viewMode={viewMode}
                      searchQuery={searchQuery}
                      containerColor={containerColors.get(run.head.container)}
                      expanded={expandedLines.has(run.id)}
                      onToggleDetail={onToggleLine}
                      onFieldClick={onFieldClick}
                      onLevelClick={onLevelClick}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The follow is off and the tail has moved on without the reader —
          the one moment a log viewer owes them a way back. */}
      {rows.length > 0 && !atBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 right-4 flex items-center gap-1.5 rounded-full border border-hair bg-raise px-2.5 py-1 text-[11px] text-fg-mid shadow-md hover:bg-hover"
        >
          <ArrowDown className="h-3 w-3" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
