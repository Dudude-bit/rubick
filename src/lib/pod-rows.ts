import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import { perf, sizeOf } from "@/lib/perf";
import type { ContainerInfo, PodInfo, PodStatusInfo } from "@/generated/types";

/**
 * The pod list's row, as `src-tauri/src/resources/types/pod_row.rs` builds
 * it: the columns' fields of `PodInfo` and nothing else, so a namespace of
 * ten thousand pods is a few megabytes and not thirty. The binding generator
 * only emits what a command returns, and a row arrives in events, so the
 * shape is picked from the generated `PodInfo` rather than written twice.
 */
export type PodRow = Pick<
  PodInfo,
  | "name"
  | "namespace"
  | "uid"
  | "nodeName"
  | "podIp"
  | "labels"
  | "createdAt"
  | "restartCount"
  | "lastRestartAt"
  | "cpuRequests"
  | "cpuLimits"
  | "memoryRequests"
  | "memoryLimits"
> & {
  status: Pick<PodStatusInfo, "phase" | "display">;
  containers: RowContainer[];
  initContainers: RowContainer[];
};

export type RowContainer = Pick<
  ContainerInfo,
  "name" | "ready" | "started" | "phase" | "state"
>;

interface BatchPayload {
  stream_id: string;
  rows: PodRow[];
}

interface DonePayload {
  stream_id: string;
  rows: number;
  complete: boolean;
  elapsed_ms: number;
}

interface FailedPayload {
  stream_id: string;
  message: string;
}

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
  const onAbort = () => {
    stop();
    settle.reject(signal?.reason);
  };

  const off = await Promise.all([
    listen<BatchPayload>("pod-rows-batch", (event) => {
      if (event.payload.stream_id !== id) return;
      for (const row of event.payload.rows) rows.push(row);
      if (perf.recording) bytes += sizeOf(event.payload.rows).bytes ?? 0;
    }),
    listen<DonePayload>("pod-rows-done", (event) => {
      if (event.payload.stream_id !== id) return;
      if (event.payload.complete) settle.resolve(rows);
      else settle.reject(new Error("the pod list was stopped before it ended"));
    }),
    listen<FailedPayload>("pod-rows-failed", (event) => {
      if (event.payload.stream_id !== id) return;
      settle.reject(new Error(event.payload.message));
    }),
  ]);
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await commands.podRowsSubscribed(id);
    const result = await answer;
    if (perf.recording && perf.generation === generation) {
      const at = performance.now();
      perf.record({
        kind: "ipc",
        name: "listPodRows",
        ms: at - started,
        at,
        rows: result.length,
        bytes,
      });
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    for (const unlisten of off) unlisten();
  }
}
