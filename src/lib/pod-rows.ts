import {
  credentialsExpired,
  expiryReason,
  isCredentialsExpired,
} from "@/lib/credentials";

import { commands } from "@/lib/commands";
import { listenEvent } from "@/lib/events";
import { stallWatch } from "@/lib/stall-watch";
import { perf, sizeOf } from "@/lib/perf";
import type { PodRow } from "@/generated/types";

export type { PodRow, RowContainer } from "@/generated/types";

/**
 * The pod list, streamed in chunks under the IPC target and reassembled
 * here. The listeners are installed before the gate is released: a chunk
 * emitted before `listen` resolved has no replay, and the list would be
 * short by exactly that chunk with nothing saying so.
 */
export async function listPodRows(
  namespace: string | null,
  signal?: AbortSignal
): Promise<PodRow[]> {
  const started = performance.now();
  const generation = perf.generation;
  const id = await commands.listPodRows(namespace);
  const stop = () => void commands.stopPodRows(id).catch(() => {});
  if (signal?.aborted) {
    stop();
    throw signal.reason;
  }

  const rows: PodRow[] = [];
  let bytes = 0;
  let settle: {
    resolve: (rows: PodRow[]) => void;
    reject: (reason: unknown) => void;
  };
  const answer = new Promise<PodRow[]>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Handled from the moment it exists. Nothing awaits it until after two
  // IPC round trips below, and an abort landing in that window rejected a
  // promise nobody was listening to — an unhandled rejection, which the
  // window's own handler turns into an error toast about a list the reader
  // themself walked away from.
  answer.catch(() => {});
  const onAbort = () => {
    stop();
    settle.reject(signal?.reason);
  };

  const off = await Promise.all([
    listenEvent("pod-rows-batch", (event) => {
      if (event.payload.stream_id !== id) return;
      for (const row of event.payload.rows) rows.push(row);
      if (perf.recording) bytes += sizeOf(event.payload.rows).bytes ?? 0;
    }),
    listenEvent("pod-rows-done", (event) => {
      if (event.payload.stream_id !== id) return;
      if (!event.payload.complete) {
        settle.reject(new Error("the pod list was stopped before it ended"));
        return;
      }
      // The backend says how many it emitted. The batches travel a broadcast
      // bus, and a chunk lost on the way would otherwise arrive here as a
      // shorter list with nothing to say it is short — a pod list missing
      // five hundred pods, drawn as the whole truth.
      if (rows.length !== event.payload.rows) {
        settle.reject(
          new Error(
            `the pod list lost ${event.payload.rows - rows.length} of ${event.payload.rows} rows on the way`
          )
        );
        return;
      }
      settle.resolve(rows);
    }),
    listenEvent("pod-rows-failed", (event) => {
      if (event.payload.stream_id !== id) return;
      // A failure that arrives as an *event* never passes the command
      // wrapper, which is the one place that notices an expired session —
      // so a 401 mid-stream left the marker to be rendered at the reader
      // verbatim and the sign-in screen never came up. Noticed here too.
      if (isCredentialsExpired(event.payload.message)) {
        credentialsExpired(expiryReason(event.payload.message));
      }
      settle.reject(new Error(event.payload.message));
    }),
  ]);
  signal?.addEventListener("abort", onAbort, { once: true });
  // Again, now the listener is on: installing one on an already-aborted
  // signal never fires, and the three `listen` round trips above are a real
  // window for the screen to go away in.
  if (signal?.aborted) onAbort();

  try {
    await commands.podRowsSubscribed(id);
    const result = await answer;
    if (perf.recording && perf.generation === generation) {
      const at = performance.now();
      perf.record({
        kind: "ipc",
        // Not `listPodRows`: the command wrapper already records a sample
        // under that name for the handshake alone, and two operations
        // sharing one row make the p50 read as the sub-millisecond half
        // while the count doubles.
        name: "listPodRows (stream)",
        ms: at - started,
        at,
        rows: result.length,
        bytes,
      });
    }
    // The biggest answer in the app used to be `PodInfo[]` off a command,
    // which the always-on stall watch saw for free. It is a stream id now,
    // so "Largest answer" said "nothing over a thousand rows" while ten
    // thousand rows went past. Told here, where the rows actually are.
    stallWatch.noteAnswer("listPodRows", result);
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    for (const unlisten of off) unlisten();
  }
}
