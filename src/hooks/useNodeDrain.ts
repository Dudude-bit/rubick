/**
 * Driving one node drain, from the click to the last event.
 *
 * A drain is the app's other long operation — the first was cross-cluster
 * search — and it is long for a reason worth stating: the eviction API
 * refuses while a PodDisruptionBudget has nothing spare and agrees the
 * moment a replacement is ready, so a drain that gives up on the first
 * refusal is not draining, it is reporting. The backend keeps asking; this
 * hook carries what it says.
 *
 * The order below is the whole trick, and it is search's: start, install the
 * listeners, and only then tell the backend it is subscribed. The backend
 * holds its first event until that call, so a fast cluster cannot answer
 * into a window that is not listening yet.
 *
 * @module hooks/useNodeDrain
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { commands } from "@/lib/commands";
import type { DrainOptions } from "@/generated/types";

/**
 * The event payloads, mirrored by hand.
 *
 * The generator only emits types a command's signature reaches, and these
 * live in `AppEvent` — the same reason `useResourceSearch` writes out
 * `SearchHit`. What that convention has always lacked is a way to notice
 * drift, so `drain::tests::the_shapes_the_frontend_mirrors_by_hand` pins
 * every name below on the Rust side and points back here when one moves.
 */

/** Mirrors `drain::DrainRefusal`. */
export type DrainRefusal =
  "notNow" | "nothingWouldReplaceIt" | "holdsLocalData" | "other";

/** Mirrors `drain::DrainOutcome`. */
export type DrainOutcome = "drained" | "stopped" | "cancelled" | "failed";

/** Mirrors `drain::RefusedPod`. */
export interface RefusedPod {
  namespace: string;
  name: string;
  refusal: DrainRefusal;
  message: string | null;
}

/** Mirrors `drain::DrainReport`. */
export interface DrainReport {
  evicted: number;
  alreadyGone: number;
  daemonsetPodsLeft: number;
  refused: RefusedPod[];
}

/** `drain-progress` event payload. */
interface DrainProgressEvent {
  drain_id: string;
  node: string;
  attempt: number;
  report: DrainReport;
}

/** `drain-finished` event payload. */
interface DrainFinishedEvent {
  drain_id: string;
  node: string;
  outcome: DrainOutcome;
  report: DrainReport;
  message: string | null;
}

export type DrainState =
  | { phase: "idle" }
  /** Started, and nothing has come back yet. */
  | { phase: "starting"; node: string }
  | { phase: "running"; node: string; attempt: number; report: DrainReport }
  | {
      phase: "done";
      node: string;
      outcome: DrainOutcome;
      report: DrainReport;
      message: string | null;
    }
  /** The command itself was refused — no drain ever started. */
  | { phase: "failed"; node: string; message: string };

const EMPTY: DrainReport = {
  evicted: 0,
  alreadyGone: 0,
  daemonsetPodsLeft: 0,
  refused: [],
};

/** What the caller is told the moment a drain ends. */
export interface DrainFinished {
  node: string;
  outcome: DrainOutcome;
  report: DrainReport;
  message: string | null;
}

export function useNodeDrain({
  onFinished,
}: {
  /**
   * Called once, from the event handler that ends the drain.
   *
   * A callback rather than the caller watching `state`: reacting to a state
   * change with an effect that sets more state is the cascade React asks you
   * not to write, and the linter says so. The finish already has a moment —
   * this is it.
   */
  onFinished?: (result: DrainFinished) => void;
} = {}) {
  const [state, setState] = useState<DrainState>({ phase: "idle" });

  // Read at call time, so a caller can close over fresh values without
  // reinstalling a listener on every render. Written in an effect rather
  // than during render, which React does not allow for a ref.
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  // Held in a ref rather than state: the event handlers close over it, and a
  // re-render is not what should reinstall a listener.
  const drainId = useRef<string | null>(null);
  const unlisteners = useRef<Array<() => void>>([]);
  const disposed = useRef(false);

  const detach = useCallback(() => {
    while (unlisteners.current.length > 0) unlisteners.current.pop()?.();
  }, []);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      detach();
      // Deliberately not cancelled. Pods are already moving; walking away
      // from the window is not a decision to stop a cluster operation
      // half-done, and a drain nobody is watching still finishes.
    };
  }, [detach]);

  const start = useCallback(
    async (node: string, options: DrainOptions) => {
      detach();
      drainId.current = null;
      setState({ phase: "starting", node });

      try {
        const handle = await commands.startNodeDrain(node, options);
        if (disposed.current) {
          await commands.cancelNodeDrain(handle.drainId).catch(() => {});
          return;
        }
        drainId.current = handle.drainId;
        setState({ phase: "running", node, attempt: 0, report: EMPTY });

        const [offProgress, offFinished] = await Promise.all([
          listen<DrainProgressEvent>("drain-progress", (event) => {
            if (event.payload.drain_id !== drainId.current) return;
            setState({
              phase: "running",
              node: event.payload.node,
              attempt: event.payload.attempt,
              report: event.payload.report,
            });
          }),
          listen<DrainFinishedEvent>("drain-finished", (event) => {
            if (event.payload.drain_id !== drainId.current) return;
            drainId.current = null;
            const { node: ended, outcome, report, message } = event.payload;
            setState({ phase: "done", node: ended, outcome, report, message });
            finished.current?.({ node: ended, outcome, report, message });
          }),
        ]);

        if (disposed.current) {
          offProgress();
          offFinished();
          return;
        }
        unlisteners.current.push(offProgress, offFinished);

        // Listeners installed — release the backend's gate.
        await commands.nodeDrainSubscribed(handle.drainId);
      } catch (error) {
        if (disposed.current) return;
        setState({
          phase: "failed",
          node,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [detach]
  );

  /** Stop asking. What has already been evicted stays evicted. */
  const cancel = useCallback(() => {
    const id = drainId.current;
    if (!id) return;
    commands.cancelNodeDrain(id).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    detach();
    drainId.current = null;
    setState({ phase: "idle" });
  }, [detach]);

  return { state, start, cancel, reset };
}
