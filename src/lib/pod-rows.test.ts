import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { perf } from "@/lib/perf";
import { listPodRows, type PodRow } from "./pod-rows";

type Handler = (event: { payload: unknown }) => void;

const calls = vi.hoisted(() => ({
  order: [] as string[],
  listeners: {} as Record<string, Handler>,
  stopped: [] as string[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: Handler) => {
    calls.order.push(`listen:${event}`);
    calls.listeners[event] = handler;
    return () => {
      delete calls.listeners[event];
    };
  }),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    listPodRows: vi.fn(async () => "pods-1"),
    podRowsSubscribed: vi.fn(async (id: string) => {
      calls.order.push(`subscribed:${id}`);
    }),
    stopPodRows: vi.fn(async (id: string) => {
      calls.stopped.push(id);
    }),
  },
}));

const row = (name: string) => ({ name, namespace: "shop" }) as PodRow;

function emit(event: string, payload: unknown) {
  calls.listeners[event]?.({ payload });
}

/** Let the reader install its listeners and release the gate. */
async function settled() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  calls.order.length = 0;
  calls.stopped.length = 0;
  for (const key of Object.keys(calls.listeners)) delete calls.listeners[key];
});

afterEach(() => {
  perf.stop();
});

describe("listPodRows", () => {
  /** A chunk emitted before the listener exists has no replay: the list would be short by one chunk, silently. */
  it("installs every listener before releasing the gate", async () => {
    const answer = listPodRows(null);
    await settled();
    const gate = calls.order.indexOf("subscribed:pods-1");
    expect(gate).toBeGreaterThan(-1);
    for (const event of [
      "pod-rows-batch",
      "pod-rows-done",
      "pod-rows-failed",
    ]) {
      const index = calls.order.indexOf(`listen:${event}`);
      expect(index, `${event} listener`).toBeGreaterThan(-1);
      expect(index).toBeLessThan(gate);
    }
    emit("pod-rows-done", { stream_id: "pods-1", rows: 0, complete: true });
    await expect(answer).resolves.toEqual([]);
  });

  /** Chunks are one list. Losing their order would resort the table on every reload. */
  it("reassembles the chunks in arrival order and resolves on done", async () => {
    const answer = listPodRows("shop");
    await settled();
    emit("pod-rows-batch", { stream_id: "pods-1", rows: [row("a"), row("b")] });
    emit("pod-rows-batch", { stream_id: "pods-1", rows: [row("c")] });
    emit("pod-rows-done", { stream_id: "pods-1", rows: 3, complete: true });
    const rows = await answer;
    expect(rows.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(calls.listeners["pod-rows-batch"]).toBeUndefined();
  });

  /**
   * The backend says how many rows it emitted, and the batches travel a
   * broadcast bus. A chunk lost on the way arrived here as a shorter list
   * with nothing to say it was short: five hundred pods missing from a pod
   * list, drawn as the whole truth, which is the one thing this app exists
   * not to do.
   */
  it("refuses a list that arrived short of the count the backend sent", async () => {
    const answer = listPodRows("shop");
    await settled();
    emit("pod-rows-batch", { stream_id: "pods-1", rows: [row("a")] });
    // The backend emitted three; one batch never made it across.
    emit("pod-rows-done", { stream_id: "pods-1", rows: 3, complete: true });
    await expect(answer).rejects.toThrow(/lost 2 of 3/);
  });

  /**
   * A failure that arrives as an event never passes through the command
   * wrapper, and that wrapper is the only place an expired session is
   * noticed. Before this, a 401 part-way through the pod list rendered the
   * raw `CREDENTIALS_EXPIRED:` wire marker at the reader and left the app
   * looking merely broken.
   */
  it("notices an expired session in a failure that came as an event", async () => {
    const { readExpiredCredentials, credentialsRestored } =
      await import("./credentials");
    credentialsRestored();

    const answer = listPodRows("shop");
    await settled();
    emit("pod-rows-failed", {
      stream_id: "pods-1",
      message: "CREDENTIALS_EXPIRED: the token expired at 12:00",
    });
    await expect(answer).rejects.toThrow(/CREDENTIALS_EXPIRED/);
    expect(readExpiredCredentials()?.reason).toBe("the token expired at 12:00");
    credentialsRestored();
  });

  /** Another screen's stream shares the channel; its rows are not this list's. */
  it("ignores chunks addressed to another stream", async () => {
    const answer = listPodRows(null);
    await settled();
    emit("pod-rows-batch", { stream_id: "pods-2", rows: [row("x")] });
    emit("pod-rows-done", { stream_id: "pods-2", rows: 1, complete: true });
    emit("pod-rows-done", { stream_id: "pods-1", rows: 0, complete: true });
    await expect(answer).resolves.toEqual([]);
  });

  /** A refused list is an error the screen shows, in the cluster's words, not an empty list. */
  it("rejects with the backend's message when the list fails", async () => {
    const answer = listPodRows(null);
    await settled();
    emit("pod-rows-batch", { stream_id: "pods-1", rows: [row("a")] });
    emit("pod-rows-failed", {
      stream_id: "pods-1",
      message: 'pods is forbidden: User "narrow" cannot list resource "pods"',
    });
    await expect(answer).rejects.toThrow('User "narrow" cannot list');
  });

  /** A stopped list is not the whole list; resolving it would show the first chunk as the cluster. */
  it("rejects a list that ended before it was complete", async () => {
    const answer = listPodRows(null);
    await settled();
    emit("pod-rows-batch", { stream_id: "pods-1", rows: [row("a")] });
    emit("pod-rows-done", { stream_id: "pods-1", rows: 1, complete: false });
    await expect(answer).rejects.toThrow("stopped");
  });

  /** A screen that navigated away must not leave the backend paging ten thousand pods for nobody. */
  it("stops the stream and rejects when the query is aborted", async () => {
    const controller = new AbortController();
    const answer = listPodRows(null, controller.signal);
    await settled();
    controller.abort();
    await expect(answer).rejects.toBeDefined();
    expect(calls.stopped).toEqual(["pods-1"]);
  });

  /** The recorder is what a PR quotes; a streamed list that recorded nothing would look free. */
  it("records one ipc sample with the row count while Diagnostics records", async () => {
    perf.start();
    const answer = listPodRows(null);
    await settled();
    emit("pod-rows-batch", { stream_id: "pods-1", rows: [row("a"), row("b")] });
    emit("pod-rows-done", { stream_id: "pods-1", rows: 2, complete: true });
    await answer;
    // Its own name: the command wrapper records the handshake under
    // `listPodRows`, and folding the whole stream into that row made the
    // p50 the handshake's and doubled the call count.
    const stats = perf.report()?.ipc["listPodRows (stream)"];
    expect(stats?.count).toBe(1);
    expect(stats?.maxRows).toBe(2);
    expect(stats?.maxBytes).toBeGreaterThan(0);
  });

  /**
   * The pod list is the biggest answer the app receives, and the always-on
   * stall watch saw it for free while it came back from a command. It is a
   * stream id now, so "Largest answer" read "nothing over a thousand rows"
   * with ten thousand rows going past.
   */
  it("tells the stall watch how many rows actually arrived", async () => {
    const { stallWatch } = await import("./stall-watch");
    stallWatch.reset();
    const answer = listPodRows(null);
    await settled();
    const many = Array.from({ length: 1200 }, (_, i) => row(`p${i}`));
    emit("pod-rows-batch", { stream_id: "pods-1", rows: many });
    emit("pod-rows-done", { stream_id: "pods-1", rows: 1200, complete: true });
    await answer;
    expect(stallWatch.report().largest?.rows).toBe(1200);
  });
});
