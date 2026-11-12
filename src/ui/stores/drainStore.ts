/**
 * The node drains this window started, from the click to the last event.
 *
 * A drain is the app's other long operation — the first was cross-cluster
 * search — and it is long for a reason worth stating: the eviction API
 * refuses while a PodDisruptionBudget has nothing spare and agrees the
 * moment a replacement is ready, so a drain that gives up on the first
 * refusal is not draining, it is reporting. The backend keeps asking; this
 * store carries what it says.
 *
 * Kept here and not in the page that started one: the backend goes on asking
 * after the dialog closes, after another node's dialog opens and after the
 * page is left, and a drain the window forgot is one nobody can see or stop.
 *
 * The order is search's: the listeners are up before a drain is started, and
 * only then is the backend told it is subscribed. It holds its first event
 * until that call, so a fast cluster cannot answer into a window that is not
 * listening yet.
 */

import { create } from "zustand";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type {
  DrainOptions,
  DrainOutcome,
  DrainReport,
} from "@/generated/types";
import { listenEvent } from "@/lib/events";
import { keptByName } from "@/lib/kept-by-name";

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
  | {
      phase: "running";
      node: string;
      attempt: number;
      report: DrainReport;
      /** The event bridge fell behind since this report; the ending may have been dropped. */
      missed: boolean;
    }
  | {
      phase: "done";
      node: string;
      /** `null` for a drain the backend no longer runs whose ending never arrived. */
      outcome: DrainOutcome | null;
      report: DrainReport;
      message: string | null;
    }
  /** The command itself was refused — no drain ever started. */
  | { phase: "failed"; node: string; message: string };

const IDLE: DrainState = { phase: "idle" };

const EMPTY: DrainReport = {
  evicted: 0,
  alreadyGone: 0,
  leaving: 0,
  daemonsetPodsLeft: 0,
  staticPodsLeft: 0,
  refused: [],
};

/** What a listener is told the moment a drain ends. */
export interface DrainFinished {
  /** Which drain of the store it was. See `drainKey`. */
  key: string;
  node: string;
  outcome: DrainOutcome | null;
  report: DrainReport;
  message: string | null;
}

/** How long an ending still on its way is waited for before it is called lost. */
export const ENDING_GRACE_MS = 2000;

/** A node's name is unique in one cluster only. */
export const drainKey = (context: string, node: string) =>
  `${context}\u0000${node}`;

interface DrainStore {
  drains: Record<string, DrainState>;
  /** The drain whose dialog is open, so its ending is not also said in a toast. */
  shown: string | null;
}

export const useDrainStore = create<DrainStore>(() => ({
  drains: {},
  shown: null,
}));

interface Handle {
  drainId: string | null;
  /**
   * Stop was pressed before there was anything to stop.
   *
   * `startNodeDrain` is a round trip, and the dialog is on screen for all of
   * it — with a Stop button that did nothing, which is worse than no button.
   * The wish is remembered and spent the moment the handle arrives.
   */
  wantsStop: boolean;
}

const handles = new Map<string, Handle>();
const finishedBy = new Set<(result: DrainFinished) => void>();

const put = (key: string, state: DrainState) =>
  useDrainStore.setState((s) => ({ drains: { ...s.drains, [key]: state } }));

const keyOf = (drainId: string) =>
  [...handles].find(([, handle]) => handle.drainId === drainId)?.[0];

function ended(key: string, result: Omit<DrainFinished, "key">) {
  handles.delete(key);
  put(key, { phase: "done", ...result });
  for (const tell of [...finishedBy]) tell({ key, ...result });
}

let listening: Promise<unknown> | null = null;

/** Up from the first drain on and never taken down: a drain outlives the page that started it. */
function listen(): Promise<unknown> {
  listening ??= Promise.all([
    listenEvent("drain-progress", ({ payload }) => {
      const key = keyOf(payload.drain_id);
      if (key === undefined) return;
      put(key, {
        phase: "running",
        node: payload.node,
        attempt: payload.attempt,
        report: payload.report,
        missed: false,
      });
    }),
    listenEvent("drain-finished", ({ payload }) => {
      const key = keyOf(payload.drain_id);
      if (key === undefined) return;
      const { node, outcome, report, message } = payload;
      ended(key, { node, outcome, report, message });
    }),
    listenEvent("event-bridge-lagged", () => {
      useDrainStore.setState((s) => ({
        drains: Object.fromEntries(
          Object.entries(s.drains).map(([key, state]) => [
            key,
            state.phase === "running" ? { ...state, missed: true } : state,
          ])
        ),
      }));
      // The lag can have dropped an ending, and nothing sends one twice. The
      // backend knows a running drain by its id: one it no longer knows has
      // ended, and is held here as running for good unless that is asked.
      for (const [key, handle] of handles) {
        if (!handle.drainId) continue;
        commands.nodeDrainSubscribed(handle.drainId).catch(() => {
          setTimeout(() => {
            const state = useDrainStore.getState().drains[key];
            if (handles.get(key) !== handle || state?.phase !== "running") {
              return;
            }
            const { node, report } = state;
            ended(key, { node, outcome: null, report, message: null });
          }, ENDING_GRACE_MS);
        });
      }
    }),
  ]).catch((error: unknown) => {
    listening = null;
    throw error;
  });
  return listening;
}

/** The drain of `node` on `context`, or idle when the window holds none. */
export const drainOf = (
  drains: Record<string, DrainState>,
  context: string,
  node: string | null
): DrainState => (node && drains[drainKey(context, node)]) || IDLE;

export async function startDrain(
  context: string,
  node: string,
  options: DrainOptions
): Promise<void> {
  const key = drainKey(context, node);
  const handle: Handle = { drainId: null, wantsStop: false };
  handles.set(key, handle);
  put(key, { phase: "starting", node });

  try {
    await listen();
    const { drainId } = await commands.startNodeDrain(node, options);
    handle.drainId = drainId;
    // The name was let go while the start was in flight: nothing holds this drain.
    if (handles.get(key) !== handle) {
      await commands.cancelNodeDrain(drainId).catch(() => {});
      return;
    }
    put(key, {
      phase: "running",
      node,
      attempt: 0,
      report: EMPTY,
      missed: false,
    });
    // A stop pressed before the handle is spent now; the `drain-finished`
    // it is answered with is what ends the dialog.
    if (handle.wantsStop) {
      await commands.cancelNodeDrain(drainId).catch(() => {});
      return;
    }
    // Release the backend's gate. A stop that won the race took the gate
    // with it, and its ending is on the way.
    await commands.nodeDrainSubscribed(drainId).catch((error) => {
      if (!handle.wantsStop) throw error;
    });
  } catch (error) {
    if (handles.get(key) !== handle) return;
    if (handle.drainId === null) handles.delete(key);
    put(key, { phase: "failed", node, message: errorToShow(error) });
  }
}

/** Stop asking. What has already been evicted stays evicted. */
export function stopDrain(context: string, node: string): void {
  const handle = handles.get(drainKey(context, node));
  if (!handle) return;
  handle.wantsStop = true;
  // Nothing to cancel yet; `startDrain` spends it.
  if (handle.drainId) commands.cancelNodeDrain(handle.drainId).catch(() => {});
}

/** Lets a report go once it has been read. A drain still running is kept: forgetting it would not stop it. */
export function forgetDrain(key: string): void {
  if (handles.has(key)) return;
  useDrainStore.setState((s) => ({
    drains: Object.fromEntries(
      Object.entries(s.drains).filter(([held]) => held !== key)
    ),
  }));
}

/** Hears every drain end, whichever page started it. Returns how to stop hearing. */
export function onDrainFinished(
  tell: (result: DrainFinished) => void
): () => void {
  finishedBy.add(tell);
  return () => void finishedBy.delete(tell);
}

// The name may be another cluster's now, and the backend takes the client of
// each pass by that name: a drain is stopped rather than left asking a
// cluster nobody chose, under a row that is no longer its node.
keptByName(() => {
  for (const { drainId } of handles.values()) {
    if (drainId) commands.cancelNodeDrain(drainId).catch(() => {});
  }
  handles.clear();
  useDrainStore.setState({ drains: {}, shown: null });
});
