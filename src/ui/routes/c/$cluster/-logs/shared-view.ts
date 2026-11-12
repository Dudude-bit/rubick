import type { StreamedLogLine } from "./types";

/** What a mounted log viewer is showing, read at the moment someone asks. */
export interface LogView {
  lines: readonly StreamedLogLine[];
  previous: boolean;
}

const views = new Map<string, () => LogView>();

export function logViewKey(namespace: string, pod: string): string {
  return `${namespace}/${pod}`;
}

/** Offers the viewer's lines under `key`; the returned function withdraws them. */
export function offerLogView(key: string, read: () => LogView): () => void {
  views.set(key, read);
  return () => {
    if (views.get(key) === read) views.delete(key);
  };
}

export function readLogView(key: string): LogView | null {
  return views.get(key)?.() ?? null;
}
