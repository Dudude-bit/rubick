/// <reference lib="webworker" />
import { computeLineDiff, type DiffLine } from "@/lib/line-diff";

export interface DiffRequest {
  id: number;
  original: string;
  modified: string;
}

export interface DiffAnswer {
  id: number;
  lines: DiffLine[];
  /** Why there is no answer, when the diff could not be computed at all. */
  failed?: string;
}

self.onmessage = (event: MessageEvent<DiffRequest>) => {
  const { id, original, modified } = event.data;
  // Always an answer, even a failed one: a throw here posts nothing, and the
  // caller cannot tell silence from still-working. It would wait forever.
  try {
    const answer: DiffAnswer = { id, lines: computeLineDiff(original, modified) };
    self.postMessage(answer);
  } catch (err) {
    const failed: DiffAnswer = {
      id,
      lines: [],
      failed: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(failed);
  }
};
