import { create } from "zustand";

import { errorToShow, isRefusal, isUnanswered } from "@/lib/error-utils";
import { shownPath } from "@/lib/hide-paths";
import { useClusterStore } from "@/stores/clusterStore";

export type WriteOutcome = "refused" | "failed" | "unanswered";

export interface WriteRecord {
  id: number;
  at: number;
  context: string | null;
  title: string;
  said: string;
  outcome: WriteOutcome;
}

const KEPT = 50;

const recorded = new WeakSet<object>();
let next = 0;

interface WriteLogState {
  records: WriteRecord[];
  clear: (context: string | null) => void;
}

export const useWriteLog = create<WriteLogState>((set) => ({
  records: [],
  clear: (context) =>
    set((state) => ({
      records: state.records.filter((record) => record.context !== context),
    })),
}));

/**
 * A write that did not go through, kept after its toast is gone. The same
 * error reaches the toast and the dialog that asked for the write, and is
 * kept once.
 */
export function recordWriteFailure(title: string, error: unknown) {
  if (typeof error === "object" && error !== null) {
    if (recorded.has(error)) return;
    recorded.add(error);
  }
  const record: WriteRecord = {
    id: next++,
    at: Date.now(),
    context: useClusterStore.getState().currentContext,
    title,
    said: shownPath(errorToShow(error)),
    outcome: isUnanswered(error)
      ? "unanswered"
      : isRefusal(error)
        ? "refused"
        : "failed",
  };
  useWriteLog.setState((state) => ({
    records: [record, ...state.records].slice(0, KEPT),
  }));
}
