import { useCallback, useRef, useState } from "react";

import type {
  Capabilities,
  LogHistoryPage,
  LogScope,
  UsageRange,
} from "@/integrations";
import { normalizeTauriError } from "@/lib/error-utils";

import { groupKeyFor } from "../normalize";
import type { StreamedLogLine } from "../types";

/**
 * Lines from before the pane existed, fetched on demand and never on its own.
 *
 * Three rules, and each of them is the answer to a way this could quietly
 * ruin the viewer it is extending:
 *
 * **Nothing is fetched until asked.** Opening a pod's Logs tab must cost the
 * same request it costs today. A page that reached for a range on mount would
 * put somebody else's server in the critical path of every log the reader
 * opens, and a slow Loki would look like a slow app.
 *
 * **One page, then a button.** `Load older` walks backwards a page at a time.
 * Auto-paging on scroll would turn a reader dragging the scrollbar into a
 * range query per frame.
 *
 * **History never displaces the live stream.** These lines sit in front of
 * the buffer and are the first to go when the retention cap is reached — see
 * where the viewer merges them. An integration may not make the pane worse
 * than it was before the integration existed.
 */
export type HistoryState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed"; reason: string }
  | { state: "loaded"; loaded: LoadedHistory };

/** What was read, and everything that must be said about it. */
export interface LoadedHistory {
  /** The window that was asked for. */
  range: UsageRange;
  /** How many lines came back, across every page so far. */
  count: number;
  /** The limit was hit on the last page: there is more inside the range. */
  truncated: boolean;
  /** The per-query cap that was applied, for the sentence naming it. */
  limit: number;
  /**
   * Not one stream matched.
   *
   * The label-mismatch case, and the reason it is a field rather than
   * `count === 0`: a pod that genuinely wrote nothing still *has* a stream,
   * so "no streams" means the query did not find the pod at all — almost
   * always because this install spells its labels differently.
   */
  unmatched: boolean;
  labelsTried: readonly string[];
  /** The cursor for the next page back, or `null` at the end of the range. */
  older: string | null;
}

interface UseLogHistoryResult {
  state: HistoryState;
  /** Oldest first, ready to sit in front of the live buffer. */
  lines: StreamedLogLine[];
  read: (scope: LogScope, range: UsageRange) => void;
  readOlder: () => void;
  /** True while an older page is in flight, so the button can say so. */
  isPaging: boolean;
  clear: () => void;
}

export function useLogHistory(
  /** The capability's implementation, or `null` where nothing supplies it.
   *  Not named `use`: React reserves that name for its own hook and the
   *  rules-of-hooks lint reads any call to it as one. */
  ask: Capabilities["logs.history"] | null
): UseLogHistoryResult {
  const [state, setState] = useState<HistoryState>({ state: "idle" });
  const [lines, setLines] = useState<StreamedLogLine[]>([]);
  const [isPaging, setIsPaging] = useState(false);

  /**
   * History ids count **down** from zero while the stream's count up, so a
   * line's id stays its position in time across both sources without either
   * of them having to know about the other. React needs the key stable and
   * the list needs the order total; one shared axis gives both.
   */
  const nextId = useRef(0);
  const request = useRef(0);
  const asked = useRef<{ scope: LogScope; range: UsageRange } | null>(null);

  const clear = useCallback(() => {
    request.current += 1;
    nextId.current = 0;
    asked.current = null;
    setLines([]);
    setIsPaging(false);
    setState({ state: "idle" });
  }, []);

  const fetchPage = useCallback(
    async (scope: LogScope, range: UsageRange, before: string | null) => {
      if (!ask) return;
      const ticket = ++request.current;
      if (before === null) {
        nextId.current = 0;
        setLines([]);
        setState({ state: "loading" });
      } else {
        setIsPaging(true);
      }

      try {
        const page = await ask({
          scope,
          range,
          before: before ?? undefined,
        });
        if (ticket !== request.current) return;
        const converted = toStreamedLines(page, nextId);
        setLines((prev) =>
          before === null ? converted : [...converted, ...prev]
        );
        setState((prev) => ({
          state: "loaded",
          loaded: summarise(page, range, prev, converted.length),
        }));
      } catch (error) {
        if (ticket !== request.current) return;
        // A failed page is a failed page and not an empty range: an empty
        // pane where a reader asked for six hours reads as "this workload
        // was silent", which is the one thing it must never say by accident.
        setState({ state: "failed", reason: normalizeTauriError(error) });
      } finally {
        if (ticket === request.current) setIsPaging(false);
      }
    },
    [ask]
  );

  const read = useCallback(
    (scope: LogScope, range: UsageRange) => {
      asked.current = { scope, range };
      void fetchPage(scope, range, null);
    },
    [fetchPage]
  );

  const readOlder = useCallback(() => {
    const previous = asked.current;
    if (!previous || state.state !== "loaded" || state.loaded.older === null) {
      return;
    }
    void fetchPage(previous.scope, previous.range, state.loaded.older);
  }, [fetchPage, state]);

  return { state, lines, read, readOlder, isPaging, clear };
}

/**
 * The running total across pages, so "1 000 lines" becomes "2 000 lines"
 * rather than resetting to the size of the page that just landed.
 */
function summarise(
  page: LogHistoryPage,
  range: UsageRange,
  previous: HistoryState,
  added: number
): LoadedHistory {
  const before =
    previous.state === "loaded" && previous.loaded.range === range
      ? previous.loaded.count
      : 0;
  return {
    range,
    count: before + added,
    truncated: page.truncated,
    limit: page.limit,
    unmatched: page.streams === 0,
    labelsTried: page.labelsTried,
    // Only a page that filled its limit can have anything behind it. One
    // that came back short reached the start of the range, and offering to
    // load older would be offering a request that answers nothing.
    older: page.truncated ? (page.lines[0]?.cursor ?? null) : null,
  };
}

/**
 * A store's line in the shape the buffer holds, with the same `groupKey` the
 * live path computes — so a message repeated fifty times before the crash
 * collapses the same way it would have live.
 */
function toStreamedLines(
  page: LogHistoryPage,
  nextId: { current: number }
): StreamedLogLine[] {
  const base = nextId.current - page.lines.length;
  nextId.current = base;
  return page.lines.map((line, index) => {
    const streamed: StreamedLogLine = {
      id: base + index,
      epoch: line.epoch,
      groupKey: "",
      // The store's clock, in the column that shows it. Kubernetes writes
      // RFC3339 here and so does this, so nothing downstream learns where
      // the line came from.
      timestamp: new Date(line.epoch).toISOString(),
      message: line.message,
      level: line.level,
      format: line.format,
      fields: line.fields,
      raw: line.raw,
      pod: line.pod,
      container: line.container,
      namespace: line.namespace,
    };
    streamed.groupKey = groupKeyFor(streamed);
    return streamed;
  });
}
