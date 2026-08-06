import {
  useCallback,
  useEffect,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";

import { LogLineComponent } from "./LogLine";
import type { StreamedLogLine } from "./hooks/useLogStream";
import { logsToText, type ViewMode } from "./types";

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
 * measured for real, because a line with parsed fields is two rows tall and
 * a wrapped line in a 360px peek panel can be five.
 */
const ESTIMATED_ROW_PX = 22;

interface LogListProps {
  /** Already filtered; the list windows exactly what it is given. */
  logs: StreamedLogLine[];
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
  onFieldClick: (key: string, value: string) => void;
  onLevelClick: (level: string) => void;
  /** Shown in place of the list when there is nothing to window. */
  children?: ReactNode;
}

export function LogList({
  logs,
  viewMode,
  searchQuery,
  follow,
  atBottom,
  onFollowChange,
  onAtBottomChange,
  resetKey,
  oldestRetainedId,
  onFieldClick,
  onLevelClick,
  children,
}: LogListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // The compiler cannot memoize a virtualizer and so skips whatever component
  // holds one. That skip is the reason this file exists separately from
  // LogViewer, and it stops here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    // Height is cached per line, not per position, so filtering — which
    // reshuffles every index — never hands a row someone else's height.
    getItemKey: (index) => logs[index].id,
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
    if (follow && logs.length > 0) {
      el.scrollTop = el.scrollHeight;
      onAtBottomChange(true);
      return;
    }
    // Not following: the tail growing below the fold is what puts the reader
    // out of sight of it, and no scroll event fires for that.
    onAtBottomChange(
      el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
    );
  }, [follow, logs, totalSize, onAtBottomChange]);

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
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      // Out of the observer callback for the same reason as above: dropping
      // every cached height relays out the list the observer just reported.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => virtualizer.measure());
    });
    observer.observe(el);
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

  useEffect(() => {
    const cache = virtualizer.itemSizeCache;
    if (oldestRetainedId === undefined || cache.size <= logs.length * 2) return;
    for (const key of cache.keys()) {
      if (typeof key === "number" && key < oldestRetainedId) cache.delete(key);
    }
  }, [oldestRetainedId, logs.length, virtualizer]);

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
        className="h-full overflow-y-auto scrollbar-thin p-4 font-mono text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-hair"
      >
        {logs.length === 0 ? (
          children
        ) : (
          <div
            ref={listRef}
            data-log-list
            className="relative w-full"
            style={{ height: totalSize }}
          >
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <LogLineComponent
                  log={logs[item.index]}
                  viewMode={viewMode}
                  searchQuery={searchQuery}
                  onFieldClick={onFieldClick}
                  onLevelClick={onLevelClick}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* The follow is off and the tail has moved on without the reader —
          the one moment a log viewer owes them a way back. */}
      {logs.length > 0 && !atBottom && (
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
