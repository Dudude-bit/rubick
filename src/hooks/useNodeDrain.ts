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

import { commands } from "@/lib/commands";
import type {
  DrainOptions,
  DrainOutcome,
  DrainReport,
} from "@/generated/types";
import { listenEvent } from "@/lib/events";

export type {
  DrainOutcome,
  DrainRefusal,
  DrainReport,
  RefusedPod,
} from "@/generated/types";

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
  leaving: 0,
  daemonsetPodsLeft: 0,
  staticPodsLeft: 0,
  refused: [],
};

/** What the caller is told the moment a drain ends. */
export interface DrainFinished {
  node: string;
  outcome: DrainOutcome;
  report: DrainReport;
  message: string | null;
}

/** The node a drain state is about, or `null` when there is no drain. */
export function drainingNode(state: DrainState): string | null {
  return state.phase === "idle" ? null : state.node;
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
  /**
   * Stop was pressed before there was anything to stop.
   *
   * `startNodeDrain` is a round trip, and the dialog is on screen for all of
   * it — with a Stop button that did nothing, which is worse than no button.
   * The wish is remembered and spent the moment the handle arrives.
   */
  const wantsStop = useRef(false);
  /**
   * The finish listener is up. A stop sent before it is answered with a
   * `drain-finished` nobody hears, and the gate it took with it makes the
   * subscribe fail as "not found".
   */
  const listening = useRef(false);

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
      wantsStop.current = false;
      listening.current = false;
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
          listenEvent("drain-progress", (event) => {
            if (event.payload.drain_id !== drainId.current) return;
            setState({
              phase: "running",
              node: event.payload.node,
              attempt: event.payload.attempt,
              report: event.payload.report,
            });
          }),
          listenEvent("drain-finished", (event) => {
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
        listening.current = true;

        // A stop pressed while nothing was listening is spent now; the
        // `drain-finished` it is answered with is what ends the dialog.
        if (wantsStop.current) {
          await commands.cancelNodeDrain(handle.drainId).catch(() => {});
          return;
        }
        // Listeners installed — release the backend's gate. A stop that won
        // the race took the gate with it, and its ending is on the way.
        await commands.nodeDrainSubscribed(handle.drainId).catch((error) => {
          if (!wantsStop.current) throw error;
        });
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
    wantsStop.current = true;
    const id = drainId.current;
    // Nothing to cancel yet, or nobody to hear it end; `start` spends it.
    if (!id || !listening.current) return;
    commands.cancelNodeDrain(id).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    detach();
    drainId.current = null;
    setState({ phase: "idle" });
  }, [detach]);

  return { state, start, cancel, reset };
}
