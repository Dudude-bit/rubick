import { useEffect, useRef, useState } from "react";

import { computeLineDiff, SYNC_LINES, type DiffLine } from "@/lib/line-diff";
import type { DiffAnswer, DiffRequest } from "@/workers/diff.worker";

export interface LineDiffState {
  lines: DiffLine[];
  /** A worker is still on it; `lines` is the previous answer or empty. */
  computing: boolean;
  /**
   * The worker could not answer at all. Not the same as `computing`: this
   * one is over, and the caller has to say so rather than spin.
   */
  failed: boolean;
}

/** How long the buffer has to stand still before the worker is asked. */
export const SETTLE_MS = 120;

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

/**
 * Drop a worker that failed, so the next question gets a new one.
 *
 * It is shared for the life of the module, so without this one failure —
 * the module failing to load, an out-of-memory kill — is handed to every
 * later viewer in the session, each of which waits on it forever.
 */
function discard(dead: Worker) {
  if (shared !== dead) return;
  shared = null;
  dead.terminate?.();
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
    failed?: boolean;
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
      if (event.data.failed !== undefined) {
        setAnswer({ key, lines: [], failed: true });
        return;
      }
      setAnswer({ key, lines: event.data.lines });
    };
    // Anything that is not a message is still an outcome. Without these the
    // hook waits on a worker that will never speak again.
    const onBroken = () => {
      discard(target);
      setAnswer({ key, lines: [], failed: true });
    };
    target.addEventListener("message", onAnswer);
    target.addEventListener("error", onBroken);
    target.addEventListener("messageerror", onBroken);
    // Asked once typing pauses. The worker is one worker and takes its
    // messages in order, so a question posted per keystroke means the
    // answer the reader is waiting for queues behind every buffer they
    // have already moved past — and nothing can cancel a message already
    // handed over.
    const request: DiffRequest = { id, original, modified };
    const asking = setTimeout(() => target.postMessage(request), SETTLE_MS);
    return () => {
      clearTimeout(asking);
      target.removeEventListener("message", onAnswer);
      target.removeEventListener("error", onBroken);
      target.removeEventListener("messageerror", onBroken);
    };
  }, [sync, original, modified, key]);

  if (sync)
    return {
      lines: computeLineDiff(original, modified),
      computing: false,
      failed: false,
    };
  if (answer && answer.key === key)
    return {
      lines: answer.lines,
      computing: false,
      failed: answer.failed === true,
    };
  return { lines: answer?.lines ?? [], computing: true, failed: false };
}
