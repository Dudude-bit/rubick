import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listeners: Record<
  string,
  Array<(event: { payload: unknown }) => void> | undefined
> = {};
let listenReady: Promise<void> = Promise.resolve();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      await listenReady;
      (listeners[event] ??= []).push(handler);
      return () => {
        listeners[event] = listeners[event]?.filter((h) => h !== handler);
      };
    }
  ),
}));

const REPORT = {
  evicted: 0,
  alreadyGone: 0,
  leaving: 0,
  daemonsetPodsLeft: 0,
  staticPodsLeft: 0,
  refused: [],
};

function emit(event: string, payload: unknown) {
  for (const handler of listeners[event] ?? []) handler({ payload });
}

const finish = (drainId: string, node: string, outcome: string) =>
  emit("drain-finished", {
    channel: "drain-finished",
    drain_id: drainId,
    node,
    outcome,
    report: REPORT,
    message: null,
  });

/** The backend as it behaves: a stop drops the entry and the gate, and the drain ends at once. */
const backend = vi.hoisted(() => ({
  cancelled: new Set<string>(),
  started: 0,
}));
const commands = vi.hoisted(() => ({
  startNodeDrain: vi.fn(),
  cancelNodeDrain: vi.fn(),
  nodeDrainSubscribed: vi.fn(),
}));
vi.mock("@/lib/commands", () => ({ commands }));

import type { DrainOptions } from "@/generated/types";

const OPTIONS: DrainOptions = {
  ignoreDaemonsets: true,
  evictUnmanagedPods: false,
  evictPodsWithEmptydir: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The store as a window that has started no drain yet holds it. */
async function fresh() {
  vi.resetModules();
  const store = await import("./drainStore");
  const names = await import("@/lib/kept-by-name");
  const of = (node: string, context = "prod") =>
    store.drainOf(store.useDrainStore.getState().drains, context, node);
  return { ...store, ...names, commands, of };
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const key of Object.keys(listeners)) delete listeners[key];
  listenReady = Promise.resolve();
  backend.cancelled.clear();
  backend.started = 0;
  commands.startNodeDrain.mockImplementation(async () => ({
    drainId: `d${++backend.started}`,
  }));
  commands.cancelNodeDrain.mockImplementation(async (drainId: string) => {
    backend.cancelled.add(drainId);
    finish(drainId, "node-7", "cancelled");
  });
  commands.nodeDrainSubscribed.mockImplementation(async (drainId: string) => {
    if (backend.cancelled.has(drainId)) {
      throw new Error(`Drain ${drainId} not found`);
    }
  });
});

describe("a drain started for one cluster", () => {
  /** The backend ran every command on the window's cluster, and the window can be on another by the time the start arrives: the namesake node there was the one drained. Fails if the start does not name the cluster the dialog was opened on. */
  it("names that cluster to the backend", async () => {
    const { commands, startDrain } = await fresh();

    await startDrain("prod", "node-7", OPTIONS);

    expect(commands.startNodeDrain).toHaveBeenCalledWith(
      "prod",
      "node-7",
      OPTIONS
    );
  });
});

describe("stopping a drain before anyone listened", () => {
  /** Stop pressed while the start was in flight: the cancel went out before the listeners, its ending was lost, and the subscribe that followed turned a cancelled drain into a red "Drain d1 not found". */
  it("says the drain was cancelled when Stop came before the handle", async () => {
    const { commands, startDrain, stopDrain, of } = await fresh();
    const handle = deferred<{ drainId: string }>();
    commands.startNodeDrain.mockReturnValueOnce(handle.promise);

    const started = startDrain("prod", "node-7", OPTIONS);
    stopDrain("prod", "node-7");
    handle.resolve({ drainId: "d1" });
    await started;

    expect(of("node-7")).toMatchObject({ phase: "done", outcome: "cancelled" });
  });

  /** The same race one step earlier: the listeners are still going up. Fails if the drain is started, or stopped, before anything can hear it end. */
  it("says the drain was cancelled when Stop came before the listeners", async () => {
    const { commands, startDrain, stopDrain, of } = await fresh();
    const ready = deferred<void>();
    listenReady = ready.promise;

    const started = startDrain("prod", "node-7", OPTIONS);
    expect(of("node-7").phase).toBe("starting");
    stopDrain("prod", "node-7");
    expect(commands.startNodeDrain).not.toHaveBeenCalled();
    ready.resolve();
    await started;

    expect(of("node-7")).toMatchObject({ phase: "done", outcome: "cancelled" });
  });

  /** A stop that lands while the gate is being released ends the drain first; the subscribe's "not found" after it must not paint that ending red. */
  it("keeps the cancelled ending when the subscribe loses the race to the stop", async () => {
    const { commands, startDrain, stopDrain, of } = await fresh();
    const gate = deferred<void>();
    commands.nodeDrainSubscribed.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error("Drain d1 not found");
    });

    const started = startDrain("prod", "node-7", OPTIONS);
    await vi.waitFor(() =>
      expect(commands.nodeDrainSubscribed).toHaveBeenCalledWith("d1")
    );
    // The stop is answered; its `drain-finished` is still on the way.
    commands.cancelNodeDrain.mockResolvedValueOnce(undefined);
    stopDrain("prod", "node-7");
    gate.resolve();
    await started;
    expect(of("node-7").phase).toBe("running");

    finish("d1", "node-7", "cancelled");
    expect(of("node-7")).toMatchObject({ phase: "done", outcome: "cancelled" });
  });

  /** A start the cluster refused is a failure whether or not Stop was pressed; there is no drain to wait on. */
  it("still reports a refused start after an early Stop", async () => {
    const { commands, startDrain, stopDrain, of } = await fresh();
    const handle = deferred<{ drainId: string }>();
    commands.startNodeDrain.mockReturnValueOnce(handle.promise);

    const started = startDrain("prod", "node-7", OPTIONS);
    stopDrain("prod", "node-7");
    handle.reject(new Error("nodes is forbidden"));
    await started;

    expect(of("node-7")).toMatchObject({ phase: "failed" });
  });
});

describe("a drain when the event bridge falls behind", () => {
  /** The lag can drop `drain-finished`, and nothing sends it twice; without a mark the dialog read "running" over a drain the backend had already ended. Fails if the lag is ignored. */
  it("marks the running drain as having missed reports, until the next one arrives", async () => {
    const { startDrain, of } = await fresh();
    await startDrain("prod", "node-7", OPTIONS);
    expect(of("node-7")).toMatchObject({ phase: "running", missed: false });

    emit("event-bridge-lagged", { missed: 1200 });
    expect(of("node-7")).toMatchObject({ phase: "running", missed: true });

    emit("drain-progress", {
      drain_id: "d1",
      node: "node-7",
      attempt: 4,
      report: { ...REPORT, evicted: 3 },
    });
    expect(of("node-7")).toMatchObject({
      phase: "running",
      attempt: 4,
      missed: false,
    });
  });
});

describe("a drain whose ending the event bridge dropped", () => {
  const lagThenWait = async (ms: number) => {
    emit("event-bridge-lagged", { missed: 1200 });
    await vi.advanceTimersByTimeAsync(ms);
  };
  const started = async () => {
    const window = await fresh();
    await window.startDrain("prod", "node-7", OPTIONS);
    vi.useFakeTimers();
    return window;
  };
  const gone = () =>
    commands.nodeDrainSubscribed.mockRejectedValue(
      new Error("Drain d1 not found")
    );

  /**
   * The window holds a drain until its ending arrives, and a lag can drop
   * the ending. Fails if a drain the backend no longer runs is held as
   * running for good, with a Stop that stops nothing.
   */
  it("says the drain is over, and that how it ended is not known", async () => {
    const { of, onDrainFinished, forgetDrain, drainKey, ENDING_GRACE_MS } =
      await started();
    const heard = vi.fn();
    onDrainFinished(heard);
    gone();

    await lagThenWait(ENDING_GRACE_MS);

    expect(of("node-7")).toMatchObject({ phase: "done", outcome: null });
    expect(heard).toHaveBeenCalledTimes(1);
    forgetDrain(drainKey("prod", "node-7"));
    expect(of("node-7").phase).toBe("idle");
    vi.useRealTimers();
  });

  /** Fails if a lag alone ends a drain the backend is still running. */
  it("goes on holding a drain the backend still runs", async () => {
    const { of, ENDING_GRACE_MS } = await started();

    await lagThenWait(ENDING_GRACE_MS * 2);

    expect(commands.nodeDrainSubscribed).toHaveBeenLastCalledWith("d1");
    expect(of("node-7")).toMatchObject({ phase: "running", missed: true });
    vi.useRealTimers();
  });

  /** An ending still on its way says how the drain ended. Fails if asking the backend beats it to "not known", or if the ending is then told twice. */
  it("takes the ending that arrives while it waits", async () => {
    const { of, onDrainFinished, ENDING_GRACE_MS } = await started();
    const heard = vi.fn();
    onDrainFinished(heard);
    gone();

    await lagThenWait(ENDING_GRACE_MS / 2);
    finish("d1", "node-7", "stopped");
    await vi.advanceTimersByTimeAsync(ENDING_GRACE_MS);

    expect(of("node-7")).toMatchObject({ phase: "done", outcome: "stopped" });
    expect(heard).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("a drain the window started and then looked away from", () => {
  /**
   * The window held one drain. Opening Drain on a second node forgot the
   * first, which went on evicting with no Stop and nothing showing it. Fails
   * if a second drain takes the first one's place, or if Stop on one node
   * reaches the other's drain.
   */
  it("holds a drain per node, and stops the one it is asked to", async () => {
    const { commands, startDrain, stopDrain, of } = await fresh();
    await startDrain("prod", "node-a", OPTIONS);
    await startDrain("prod", "node-b", OPTIONS);

    emit("drain-progress", {
      drain_id: "d1",
      node: "node-a",
      attempt: 7,
      report: REPORT,
    });
    expect(of("node-a")).toMatchObject({ phase: "running", attempt: 7 });
    expect(of("node-b")).toMatchObject({ phase: "running", attempt: 0 });

    stopDrain("prod", "node-a");
    expect(commands.cancelNodeDrain).toHaveBeenCalledTimes(1);
    expect(commands.cancelNodeDrain).toHaveBeenCalledWith("d1");
    expect(of("node-b").phase).toBe("running");
  });

  /** Two clusters each have a `node-1`. Fails if a drain on one is drawn, or stopped, as the other's. */
  it("keeps a node's drain to the cluster it was started on", async () => {
    const { commands, startDrain, stopDrain, of } = await fresh();
    await startDrain("prod", "node-1", OPTIONS);

    expect(of("node-1", "staging").phase).toBe("idle");
    stopDrain("staging", "node-1");
    expect(commands.cancelNodeDrain).not.toHaveBeenCalled();
    expect(of("node-1", "prod").phase).toBe("running");
  });

  /**
   * Closing a finished report clears it. Fails if the same call can drop a
   * drain that is still running: forgetting it does not stop it.
   */
  it("lets a report go once it has ended, and never a drain that is running", async () => {
    const { startDrain, forgetDrain, drainKey, of } = await fresh();
    await startDrain("prod", "node-7", OPTIONS);

    forgetDrain(drainKey("prod", "node-7"));
    expect(of("node-7").phase).toBe("running");

    finish("d1", "node-7", "stopped");
    expect(of("node-7")).toMatchObject({ phase: "done", outcome: "stopped" });
    forgetDrain(drainKey("prod", "node-7"));
    expect(of("node-7").phase).toBe("idle");
  });

  /** The ending was told to the page that started the drain, so it was told to nobody once that page was left. Fails if an ending reaches no listener that asked after the start. */
  it("tells whoever is listening that a drain ended, and which", async () => {
    const { startDrain, onDrainFinished, drainKey } = await fresh();
    await startDrain("prod", "node-7", OPTIONS);
    const heard = vi.fn();
    const off = onDrainFinished(heard);

    finish("d1", "node-7", "stopped");

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toMatchObject({
      key: drainKey("prod", "node-7"),
      node: "node-7",
      outcome: "stopped",
    });
    off();
  });

  /**
   * A kubeconfig change can put another cluster behind the context's name,
   * and the backend takes each pass's client by that name. Fails if a drain
   * is left running under a name that is no longer its cluster, or is drawn
   * on the namesake node.
   */
  it("stops its drains when the context names may be other clusters", async () => {
    const { commands, startDrain, namesRebound, of } = await fresh();
    await startDrain("prod", "node-7", OPTIONS);

    namesRebound();

    expect(commands.cancelNodeDrain).toHaveBeenCalledWith("d1");
    expect(of("node-7").phase).toBe("idle");
  });
});
