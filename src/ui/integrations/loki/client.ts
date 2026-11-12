/**
 * Loki's answers, turned into the shape the log viewer already holds.
 *
 * The HTTP is the backend's — this file sends a stream selector and reads
 * lines, and never sees the credential. What it owns is the honesty: a page
 * that filled its limit is marked as partial, a query that matched no stream
 * at all is distinguished from one that matched a silent pod, and both facts
 * travel with the lines rather than being inferred from an empty array.
 */

import { commands } from "@/lib/commands";
import { RANGE_WINDOW_MS } from "../registry";
import type { HistoryLine, LogHistory, LogHistoryPage } from "../registry";
import { LOKI_LABELS, streamSelector } from "./queries";

/**
 * Lines per query, and the reason it is not larger.
 *
 * A 24h range over a chatty workload is millions of lines. The point of a
 * cap is not to protect Loki — it is that a pane cannot show a million lines
 * and a reader cannot read them, so fetching them would spend a minute to
 * arrive at the same first screen. One page, and "Load older" for the reader
 * who is actually walking backwards through an incident.
 *
 * The backend clamps to the same number, so this is the agreed size rather
 * than a request that might be honoured.
 */
export const PAGE_LINES = 1000;

/**
 * One page of what Loki kept, oldest first.
 *
 * Newest-first on the wire and never the other way round: a range that holds
 * more lines than the limit must lose its *oldest*, so that "the newest 1 000
 * lines of the last 6 hours" is a true sentence about what is on screen. A
 * forward query would have answered with the first thousand lines of six
 * hours ago and called it the range.
 */
export async function logHistory(input: LogHistory): Promise<LogHistoryPage> {
  const end = Date.now();
  const start = end - RANGE_WINDOW_MS[input.range];

  const page = await commands.lokiQueryRange(
    streamSelector(input.scope),
    start,
    end,
    PAGE_LINES,
    input.before ?? null
  );

  return {
    lines: page.lines.map(({ ts, line }): HistoryLine => ({
      cursor: ts,
      // Loki's clock, already resolved in Rust from its nanosecond
      // timestamp. Never arrival order — these lines arrive in one batch
      // and were written across hours.
      epoch: line.timestamp ? Date.parse(line.timestamp) : 0,
      message: line.message,
      raw: line.raw,
      segments: line.segments,
      pod: line.pod,
      container: line.container,
      namespace: line.namespace,
      level: line.level,
      format: line.format,
      fields: line.fields,
    })),
    truncated: page.truncated,
    limit: page.limit,
    streams: page.streams,
    labelsTried: LOKI_LABELS,
  };
}
