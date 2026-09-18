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
}

self.onmessage = (event: MessageEvent<DiffRequest>) => {
  const { id, original, modified } = event.data;
  const answer: DiffAnswer = { id, lines: computeLineDiff(original, modified) };
  self.postMessage(answer);
};
