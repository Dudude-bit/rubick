import { useEffect, useRef, useState } from "react";

import { computeLineDiff, SYNC_LINES, type DiffLine } from "@/lib/line-diff";
import type { DiffAnswer, DiffRequest } from "@/workers/diff.worker";

export interface LineDiffState {
  lines: DiffLine[];
  /** A worker is still on it; `lines` is the previous answer or empty. */
  computing: boolean;
}

let shared: Worker | null = null;
let nextId = 0;

/** One worker for every viewer, made the first time one is needed. */
function worker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  shared ??= new Worker(new URL("../workers/diff.worker.ts", import.meta.url), {
    type: "module",
  });
  return shared;
}

function small(original: string, modified: string): boolean {
  let lines = 1;
  for (const text of [original, modified]) {
    for (
      let at = text.indexOf("\n");
      at !== -1;
      at = text.indexOf("\n", at + 1)
    ) {
      lines += 1;
      if (lines > SYNC_LINES) return false;
    }
  }
  return true;
}

/**
 * The diff of two texts, computed where it does not stall the frame.
 *
 * Small inputs are diffed right here, synchronously: the round trip to a
 * worker costs more than the answer. Anything larger goes to one shared
 * worker, and an answer that arrives for a question the caller has moved
 * past is dropped, so typing never draws a diff of an older buffer over a
 * newer one. Where there is no `Worker` at all (jsdom), everything is
 * synchronous, and the tests that run there see the same answers.
 */
export function useLineDiff(original: string, modified: string): LineDiffState {
  const sync = small(original, modified) || worker() === null;
  const [answer, setAnswer] = useState<{
    key: string;
    lines: DiffLine[];
  } | null>(null);
  const asked = useRef(0);
  const key = `${original.length}:${modified.length}:${original}\u0000${modified}`;

  useEffect(() => {
    if (sync) return;
    const target = worker();
    if (!target) return;
    const id = (nextId += 1);
    asked.current = id;
    const onAnswer = (event: MessageEvent<DiffAnswer>) => {
      if (event.data.id !== id) return;
      setAnswer({ key, lines: event.data.lines });
    };
    target.addEventListener("message", onAnswer);
    const request: DiffRequest = { id, original, modified };
    target.postMessage(request);
    return () => target.removeEventListener("message", onAnswer);
  }, [sync, original, modified, key]);

  if (sync)
    return { lines: computeLineDiff(original, modified), computing: false };
  if (answer && answer.key === key)
    return { lines: answer.lines, computing: false };
  return { lines: answer?.lines ?? [], computing: true };
}
