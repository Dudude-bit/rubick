// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { StreamLogConfig } from "@/generated/types";

// ----- Mocks -----

// Order tracking shared between the listen mock and the
// logStreamSubscribed mock so we can assert the contract: the listeners
// MUST be installed before any logStreamSubscribed call. With one
// stream per container the contract now has to hold N times, and one
// listener registration covers all of them — so what the assertions
// check is that *every* subscribe came after it.

let callCounter = 0;
const listenCalls: Array<{ event: string; index: number }> = [];
const subscribedCalls: Array<{ streamId: string; index: number }> = [];
const streamConfigs: StreamLogConfig[] = [];

// Captured per-event so tests can synthetically fire log-batch payloads
// at the registered handler.
const listeners: Record<
  string,
  ((event: { payload: unknown }) => void) | undefined
> = {};

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: unknown }) => void) => {
      listenCalls.push({ event, index: callCounter++ });
      listeners[event] = handler;
      return () => {
        delete listeners[event];
      };
    }
  ),
}));

vi.mock("@/lib/commands", () => ({
  commands: {
    streamPodLogs: vi.fn(async (config: StreamLogConfig) => {
      streamConfigs.push(config);
      return `stream-${config.container}`;
    }),
    stopLogStream: vi.fn(async () => undefined),
    logStreamSubscribed: vi.fn(async (streamId: string) => {
      subscribedCalls.push({ streamId, index: callCounter++ });
    }),
  },
}));

vi.mock("@/lib/error-utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/error-utils")>()),
  normalizeTauriError: (err: unknown) => String(err),
  errorToShow: (err: unknown) => String(err),
}));

import { useLogStream, DEFAULT_LOG_LIMIT } from "./useLogStream";
import { REORDER_WINDOW_MS } from "./log-buffer";

const baseProps = {
  podName: "p",
  namespace: "n",
  containers: ["c"],
  limit: DEFAULT_LOG_LIMIT,
};

const FIVE = ["json-logger", "logfmt-logger", "klog-logger", "logback", "web"];

function reset() {
  listenCalls.length = 0;
  subscribedCalls.length = 0;
  streamConfigs.length = 0;
  callCounter = 0;
  for (const k of Object.keys(listeners)) delete listeners[k];
  vi.clearAllMocks();
}

/**
 * A `log-batch` event of the shape the backend emits. The streamer
 * flushes every 50ms (or every 100 lines), so each event carries an
 * array.
 */
function logEvent(
  container: string,
  ...lines: Array<string | { message: string; timestamp: string }>
) {
  return {
    payload: {
      stream_id: `stream-${container}`,
      lines: lines.map((line) =>
        typeof line === "string"
          ? {
              message: line,
              timestamp: null,
              level: null,
              format: null,
              fields: null,
              raw: line,
            }
          : {
              message: line.message,
              timestamp: line.timestamp,
              level: null,
              format: null,
              fields: null,
              raw: line.message,
            }
      ),
    },
  };
}

function failureEvent(
  container: string,
  kind: "gone" | "broken",
  message: string
) {
  return { payload: { stream_id: `stream-${container}`, kind, message } };
}

/**
 * From here on the reorder window runs on a clock the test moves. Installed
 * once the streams have subscribed, because opening them waits on a
 * zero-delay timer of its own, and so does `waitFor` settling: no `waitFor`
 * while the clock is held. `Date` stays real: an untimestamped first line is
 * stamped with `Date.now()`.
 */
const holdTheClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** One reorder window on, with whatever it held committed. */
const pastTheWindow = () => advance(REORDER_WINDOW_MS);

afterEach(() => {
  vi.useRealTimers();
});

describe("useLogStream deferred-start handshake", () => {
  beforeEach(reset);

  it("registers the log-batch listener before every logStreamSubscribed", async () => {
    renderHook(() => useLogStream({ ...baseProps, containers: FIVE }));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(FIVE.length);
    });

    const batchCall = listenCalls.find((c) => c.event === "log-batch");
    expect(batchCall, "log-batch listener was never registered").toBeDefined();
    for (const subscribed of subscribedCalls) {
      expect(
        batchCall!.index,
        `subscribe of ${subscribed.streamId} raced the listener`
      ).toBeLessThan(subscribed.index);
    }
  });

  it("registers the stream-failed listener before every logStreamSubscribed", async () => {
    // Same contract as log-batch, and for the same reason: the backend
    // can fail on its first read the moment a gate is released, and
    // Tauri events have no replay.
    renderHook(() => useLogStream({ ...baseProps, containers: FIVE }));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(FIVE.length);
    });

    const failureCall = listenCalls.find((c) => c.event === "stream-failed");
    expect(failureCall).toBeDefined();
    for (const subscribed of subscribedCalls) {
      expect(failureCall!.index).toBeLessThan(subscribed.index);
    }
  });

  it("registers each listener once, however many containers are streamed", async () => {
    renderHook(() => useLogStream({ ...baseProps, containers: FIVE }));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(FIVE.length);
    });

    expect(listenCalls.filter((c) => c.event === "log-batch")).toHaveLength(1);
    expect(listenCalls.filter((c) => c.event === "stream-failed")).toHaveLength(
      1
    );
  });

  it("subscribes the stream id each streamPodLogs returned", async () => {
    renderHook(() => useLogStream({ ...baseProps, containers: FIVE }));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(FIVE.length);
    });

    expect(subscribedCalls.map((c) => c.streamId).sort()).toEqual(
      FIVE.map((c) => `stream-${c}`).sort()
    );
  });
});

describe("useLogStream streams every container at once", () => {
  beforeEach(reset);

  it("opens one stream per container", async () => {
    renderHook(() => useLogStream({ ...baseProps, containers: FIVE }));

    await waitFor(() => {
      expect(streamConfigs).toHaveLength(5);
    });
    expect(streamConfigs.map((c) => c.container)).toEqual(FIVE);
  });

  it("tags every line with the container it came from", async () => {
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: ["web", "sidecar"] })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(2);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(logEvent("web", "GET /checkout 200"));
      listeners["log-batch"]!(logEvent("sidecar", "proxying upstream"));
    });
    await pastTheWindow();

    expect(result.current.logs.map((l) => l.container)).toEqual([
      "web",
      "sidecar",
    ]);
  });

  it("orders one reorder window by timestamp, not by arrival", async () => {
    // Two live streams do not arrive in timestamp order. Everything
    // that lands inside one window is emitted ordered, a batch arriving
    // halfway through it included; the guarantee stops at the window
    // edge, which the next test pins down.
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: ["web", "sidecar"] })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(2);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(
        logEvent("web", {
          message: "later",
          timestamp: "2026-08-06T10:00:02.000Z",
        })
      );
    });
    await advance(REORDER_WINDOW_MS / 2);
    expect(result.current.logs, "committed before its window ran").toEqual([]);

    act(() => {
      listeners["log-batch"]!(
        logEvent("sidecar", {
          message: "earlier",
          timestamp: "2026-08-06T10:00:01.000Z",
        })
      );
    });
    await advance(REORDER_WINDOW_MS / 2);

    expect(result.current.logs.map((l) => l.message)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("does not reorder across a window boundary, and says so by doing it", async () => {
    // The honest limit of the guarantee: a line that arrives a window
    // late is appended after lines that are newer than it. Committed is
    // committed.
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: ["web", "sidecar"] })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(2);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(
        logEvent("web", {
          message: "committed first",
          timestamp: "2026-08-06T10:00:02.000Z",
        })
      );
    });
    await pastTheWindow();
    expect(result.current.logs).toHaveLength(1);

    act(() => {
      listeners["log-batch"]!(
        logEvent("sidecar", {
          message: "arrived late",
          timestamp: "2026-08-06T10:00:01.000Z",
        })
      );
    });
    await pastTheWindow();

    expect(result.current.logs.map((l) => l.message)).toEqual([
      "committed first",
      "arrived late",
    ]);
  });

  it("gives an untimestamped line the last timestamp its own stream reported", async () => {
    // Otherwise it sorts to the epoch and jumps to the top of the window.
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: ["web", "sidecar"] })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(2);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(
        logEvent(
          "web",
          { message: "stamped", timestamp: "2026-08-06T10:00:05.000Z" },
          "trailing stack frame"
        )
      );
      listeners["log-batch"]!(
        logEvent("sidecar", {
          message: "older",
          timestamp: "2026-08-06T10:00:01.000Z",
        })
      );
    });

    await pastTheWindow();

    expect(result.current.logs.map((l) => l.message)).toEqual([
      "older",
      "stamped",
      "trailing stack frame",
    ]);
  });

  it("assigns a group key so the collapse pass has something to compare", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(
        logEvent("c", "flood line 643585 done", "flood line 643586 done")
      );
    });
    await pastTheWindow();

    expect(result.current.logs).toHaveLength(2);
    const [a, b] = result.current.logs;
    expect(a.groupKey).toBe(b.groupKey);
  });
});

describe("useLogStream one cap", () => {
  beforeEach(reset);

  it("backfills each container with its share of the cap", async () => {
    renderHook(() =>
      useLogStream({ ...baseProps, containers: FIVE, limit: 5000 })
    );

    await waitFor(() => {
      expect(streamConfigs).toHaveLength(5);
    });
    expect(streamConfigs.map((c) => c.tailLines)).toEqual([
      1000, 1000, 1000, 1000, 1000,
    ]);
  });

  it("backfills the whole cap when there is one container", async () => {
    renderHook(() => useLogStream({ ...baseProps, limit: 20000 }));

    await waitFor(() => {
      expect(streamConfigs).toHaveLength(1);
    });
    expect(streamConfigs[0].tailLines).toBe(20000);
  });

  it("retains no more than the cap and reports what it dropped", async () => {
    const limit = 300;
    const { result } = renderHook(() => useLogStream({ ...baseProps, limit }));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    holdTheClock();

    const batch = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    act(() => {
      for (let i = 0; i < 6; i++) {
        listeners["log-batch"]!(logEvent("c", ...batch));
      }
    });
    await pastTheWindow();

    expect(result.current.retained).toBe(limit);
    expect(result.current.limit).toBe(limit);
    expect(result.current.dropped).toBe(300);
    // Ids stay strictly increasing across the drop, which is what the
    // virtualiser's per-line height cache is keyed on.
    const ids = result.current.logs.map((l) => l.id);
    expect(ids[0]).toBeLessThan(ids[ids.length - 1]);
    expect(new Set(ids).size).toBe(limit);
  });

  it("reports nothing dropped while the buffer is still filling", async () => {
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, limit: 1000 })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(logEvent("c", "one", "two"));
    });
    await pastTheWindow();

    expect(result.current.retained).toBe(2);
    expect(result.current.dropped).toBe(0);
  });
});

describe("useLogStream surfaces a stream that dies after it started", () => {
  beforeEach(reset);

  it("reports a deleted pod as gone, naming the container", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    expect(result.current.failures).toHaveLength(0);

    act(() => {
      listeners["stream-failed"]!(
        failureEvent(
          "c",
          "gone",
          "n/p stopped streaming: container c is no longer running."
        )
      );
    });

    await waitFor(() => {
      expect(result.current.failures).toHaveLength(1);
    });
    expect(result.current.failures[0].kind).toBe("gone");
    expect(result.current.failures[0].container).toBe("c");
    expect(result.current.isStreaming).toBe(false);
  });

  it("keeps streaming the other containers when one of five dies", async () => {
    // The sidecar exiting is not the app's logs ending, and a single
    // verdict could not tell the two apart.
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: FIVE })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(5);
    });

    act(() => {
      listeners["stream-failed"]!(failureEvent("web", "gone", "web exited"));
    });

    await waitFor(() => {
      expect(result.current.failures).toHaveLength(1);
    });
    expect(result.current.failures[0].container).toBe("web");
    expect(result.current.isStreaming).toBe(true);

    holdTheClock();
    act(() => {
      listeners["log-batch"]!(logEvent("json-logger", "still alive"));
    });
    await pastTheWindow();
    expect(result.current.logs).toHaveLength(1);
  });

  it("ignores a failure belonging to a stream it does not own", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    holdTheClock();

    act(() => {
      listeners["stream-failed"]!(
        failureEvent("someone-else", "broken", "not ours")
      );
      listeners["log-batch"]!(logEvent("c", "still alive"));
    });
    await pastTheWindow();

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.failures).toHaveLength(0);
  });

  /**
   * Dana's header said "Streaming 1 of 5" while four containers labelled
   * "not followed" went on delivering lines. Fails if a container whose
   * stream delivers lines is still counted unfollowed, or not streaming.
   */
  it("counts a container whose stream delivers lines as streaming, whatever it said before", async () => {
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: FIVE })
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(5));
    act(() => {
      for (const container of FIVE.slice(0, 4))
        listeners["stream-failed"]!(
          failureEvent(container, "broken", "fsnotify")
        );
    });
    await waitFor(() => expect(result.current.failures).toHaveLength(4));

    act(() => {
      listeners["log-batch"]!(logEvent("json-logger", "still arriving"));
    });

    await waitFor(() => expect(result.current.failures).toHaveLength(3));
    expect(
      result.current.failures.map((failure) => failure.container)
    ).not.toContain("json-logger");
    expect(result.current.isStreaming).toBe(true);
  });

  /**
   * A container followed again has a new stream; the old one's word,
   * arriving late, marked it unfollowed beside the lines the new one
   * delivered. Fails if a failure of a stream the container no longer
   * reads through is said.
   */
  it("says nothing of a stream its container has been opened again past", async () => {
    const { commands } = await import("@/lib/commands");
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: FIVE })
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(5));
    act(() => {
      listeners["stream-failed"]!(failureEvent("web", "broken", "dropped"));
    });
    await waitFor(() => expect(result.current.failures).toHaveLength(1));

    vi.mocked(commands.streamPodLogs).mockResolvedValueOnce("stream-web-2");
    act(() => result.current.retrySource("p", "web"));
    await waitFor(() => expect(subscribedCalls).toHaveLength(6));
    expect(result.current.failures).toHaveLength(0);

    act(() => {
      listeners["stream-failed"]!(failureEvent("web", "broken", "late"));
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(result.current.failures).toHaveLength(0);
    expect(result.current.isStreaming).toBe(true);
  });

  it("clears the failures when retry restarts the streams", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    act(() => {
      listeners["stream-failed"]!(failureEvent("c", "broken", "dropped"));
    });
    await waitFor(() => {
      expect(result.current.failures).toHaveLength(1);
    });

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.failures).toHaveLength(0);
    });
  });
});

describe("useLogStream stable line ids", () => {
  beforeEach(reset);

  it("assigns a unique, monotonically increasing id to each line", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(logEvent("c", "first"));
      listeners["log-batch"]!(logEvent("c", "second", "third"));
    });
    await pastTheWindow();

    const ids = result.current.logs.map((l) => l.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBeLessThan(ids[1]);
    expect(ids[1]).toBeLessThan(ids[2]);
    expect(result.current.logs.map((l) => l.message)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("preserves ids across renders so React keys stay stable", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(logEvent("c", "alpha", "beta"));
    });
    await pastTheWindow();
    expect(result.current.logs).toHaveLength(2);
    const idsBefore = result.current.logs.map((l) => l.id);

    act(() => {
      listeners["log-batch"]!(logEvent("c", "gamma"));
    });
    await pastTheWindow();
    expect(result.current.logs).toHaveLength(3);

    expect(result.current.logs[0].id).toBe(idsBefore[0]);
    expect(result.current.logs[1].id).toBe(idsBefore[1]);
  });
});

import { commands } from "@/lib/commands";
import { backfillPerContainer } from "./log-buffer";

describe("useLogStream on a workload whose pods are replaced", () => {
  beforeEach(reset);

  const line = (message: string) => ({
    message,
    timestamp: null,
    level: null,
    format: null,
    fields: null,
    raw: message,
  });

  /**
   * The open is rejected, and `sync` runs on every change of the pod set —
   * a scale, a rollout, a pod leaving. Blindly re-adding the source meant
   * a silent retry per tick and another identical banner each time, so a
   * two-pod pane read "1 of 2 pods streaming, 4 refused".
   */
  it("does not retry a refused stream because another pod joined, and says it once", async () => {
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      streamConfigs.push(config);
      if (config.podName === "api-bad") throw new Error("ImagePullBackOff");
      return `stream-${config.podName}-${config.container}`;
    });
    const good = { pod: "api-good", namespace: "n", container: "app" };
    const bad = { pod: "api-bad", namespace: "n", container: "app" };
    const extra = { pod: "api-extra", namespace: "n", container: "app" };
    const { result, rerender } = renderHook(
      ({ sources }) =>
        useLogStream({
          namespace: "n",
          sources,
          paneKey: "Deployment:api",
          limit: DEFAULT_LOG_LIMIT,
        }),
      { initialProps: { sources: [good, bad] } }
    );
    await waitFor(() => expect(result.current.failures).toHaveLength(1));

    rerender({ sources: [good, bad, extra] });
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    rerender({ sources: [good, bad] });
    await waitFor(() =>
      expect(commands.stopLogStream).toHaveBeenCalledWith(
        "stream-api-extra-app"
      )
    );

    expect(result.current.failures).toHaveLength(1);
    expect(
      streamConfigs.filter((config) => config.podName === "api-bad")
    ).toHaveLength(1);
  });

  /**
   * The apiserver refuses a log for a container that has not started, and
   * nothing else about the source changes when it does. Left alone the
   * refusal is permanent, sitting beside a pod list showing it Running.
   */
  it("asks again once a container that was still starting has started", async () => {
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      streamConfigs.push(config);
      if (streamConfigs.length === 1) throw new Error("is waiting to start");
      return `stream-${config.podName}-${config.container}`;
    });
    const waiting = {
      pod: "api-new",
      namespace: "n",
      container: "app",
      started: false,
    };
    const { result, rerender } = renderHook(
      ({ sources }) =>
        useLogStream({
          namespace: "n",
          sources,
          paneKey: "Deployment:api",
          limit: DEFAULT_LOG_LIMIT,
        }),
      { initialProps: { sources: [waiting] } }
    );
    await waitFor(() => expect(result.current.failures).toHaveLength(1));

    rerender({ sources: [{ ...waiting, started: true }] });
    await waitFor(() => expect(result.current.failures).toHaveLength(0));
    expect(streamConfigs).toHaveLength(2);
  });

  /**
   * Would put the loss back: a rollout that restarted the session would
   * drop the old pod's last words, which are the lines somebody reading
   * a rollout came for.
   *
   * The joining pod opens with no tail. The buffer is append-only and
   * everything in it is newer than that pod's history, so a backfill
   * committed now would sit after the live tail and drag a following
   * reader down into minutes of older lines.
   */
  it("keeps the old pod's lines, stops its stream and streams the new pod from here", async () => {
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      streamConfigs.push(config);
      return `stream-${config.podName}-${config.container}`;
    });
    const old = { pod: "api-old", namespace: "n", container: "app" };
    const fresh = { pod: "api-new", namespace: "n", container: "app" };
    const { result, rerender } = renderHook(
      ({ sources }) =>
        useLogStream({
          namespace: "n",
          sources,
          paneKey: "Deployment:api",
          limit: DEFAULT_LOG_LIMIT,
        }),
      { initialProps: { sources: [old] } }
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    holdTheClock();

    act(() => {
      listeners["log-batch"]!({
        payload: {
          stream_id: "stream-api-old-app",
          lines: [line("old says hi")],
        },
      });
    });
    await pastTheWindow();
    expect(result.current.logs).toHaveLength(1);
    vi.useRealTimers();

    rerender({ sources: [fresh] });
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    expect(commands.stopLogStream).toHaveBeenCalledWith("stream-api-old-app");
    expect(streamConfigs[1].podName).toBe("api-new");
    expect(streamConfigs[1].tailLines).toBe(0);
    // The first set still opens with the buffer's share of the cap.
    expect(streamConfigs[0].tailLines).toBe(
      backfillPerContainer(DEFAULT_LOG_LIMIT, 1)
    );

    holdTheClock();
    act(() => {
      listeners["log-batch"]!({
        payload: {
          stream_id: "stream-api-new-app",
          lines: [line("new says hi")],
        },
      });
    });
    await pastTheWindow();
    expect(result.current.logs.map((l) => `${l.pod}:${l.message}`)).toEqual([
      "api-old:old says hi",
      "api-new:new says hi",
    ]);
    // One session throughout: the listeners were registered once.
    expect(listenCalls.filter((c) => c.event === "log-batch")).toHaveLength(1);
  });

  /**
   * Sam's log-demo Deployment, opened again from another tab: its pod list
   * answered after the pane was listening, every stream opened as a pod
   * joining later, and the pane held 4 lines where the pod's held 1806.
   * Fails if the first streams of a session go without the backfill
   * because the pod list was late.
   */
  it("backfills the first pods of a workload pane even when its pod list arrives after the pane opened", async () => {
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      streamConfigs.push(config);
      return `stream-${config.podName}-${config.container}`;
    });
    const sources = ["a", "b"].map((pod) => ({
      pod,
      namespace: "n",
      container: "app",
    }));
    const { rerender } = renderHook(
      ({ sources }) =>
        useLogStream({
          namespace: "n",
          sources,
          paneKey: "Deployment:log-demo",
          limit: DEFAULT_LOG_LIMIT,
        }),
      { initialProps: { sources: [] as typeof sources } }
    );
    await waitFor(() =>
      expect(listenCalls.some((c) => c.event === "log-batch")).toBe(true)
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    rerender({ sources });
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    expect(streamConfigs.map((c) => c.tailLines)).toEqual([
      backfillPerContainer(DEFAULT_LOG_LIMIT, 2),
      backfillPerContainer(DEFAULT_LOG_LIMIT, 2),
    ]);

    rerender({
      sources: [...sources, { pod: "c", namespace: "n", container: "app" }],
    });
    await waitFor(() => expect(subscribedCalls).toHaveLength(3));
    expect(streamConfigs[2].tailLines).toBe(0);
  });

  it("names the pod as well as the container when a stream is refused", async () => {
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      if (config.podName === "api-b") throw new Error("forbidden");
      return `stream-${config.podName}-${config.container}`;
    });
    const { result } = renderHook(() =>
      useLogStream({
        namespace: "n",
        sources: [
          { pod: "api-a", namespace: "n", container: "app" },
          { pod: "api-b", namespace: "n", container: "app" },
        ],
        paneKey: "Deployment:api",
        limit: DEFAULT_LOG_LIMIT,
      })
    );
    await waitFor(() => expect(result.current.failures).toHaveLength(1));
    expect(result.current.failures[0]).toMatchObject({
      pod: "api-b",
      container: "app",
      kind: "broken",
    });
    expect(result.current.isStreaming).toBe(true);
  });
});

/**
 * A previous run is read to its end, and only the end of that read says
 * what the run held: the open answering is not it, and neither is an empty
 * buffer.
 */
describe("useLogStream reading a previous run", () => {
  beforeEach(() => {
    reset();
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      streamConfigs.push(config);
      return `stream-${config.container}`;
    });
  });
  afterEach(() => vi.useRealTimers());

  const readEvent = (container: string, lines: number) => ({
    payload: { stream_id: `stream-${container}`, lines },
  });
  const previous = (containers: string[]) =>
    renderHook(() =>
      useLogStream({ ...baseProps, containers, previous: true })
    );

  /**
   * The pane said "The previous run wrote nothing." from the moment the
   * streams were subscribed until the lines landed. Fails if the read is
   * called over before the backend has said so for every container.
   */
  it("has found nothing out until every read has said it ended", async () => {
    const { result } = previous(["app", "proxy"]);
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    expect(result.current.isConnecting).toBe(false);
    expect(result.current.previousRead).toBeNull();

    act(() => listeners["log-read"]!(readEvent("app", 3)));
    expect(result.current.previousRead).toBeNull();

    act(() => listeners["log-read"]!(readEvent("proxy", 0)));
    expect(result.current.previousRead).toEqual({ sources: 2, lines: 3 });
  });

  /**
   * The last lines sit in the reorder window when the read ends. Fails if
   * the read is over while the buffer is still empty of them: an empty,
   * finished pane is the false verdict, for a quarter of a second.
   */
  it("holds the last lines before it says the read is over", async () => {
    const { result } = previous(["app"]);
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    holdTheClock();

    act(() => {
      listeners["log-batch"]!(logEvent("app", "one", "two"));
      listeners["log-read"]!(readEvent("app", 2));
    });

    expect(result.current.previousRead).toEqual({ sources: 1, lines: 2 });
    expect(result.current.retained).toBe(2);
  });

  /** A read that failed has ended too, and counts for nothing read. Fails if it holds the pane on "reading" for ever, or is counted as a run that wrote nothing. */
  it("counts a read that failed as over, and not as a run that was read", async () => {
    const { result } = previous(["app", "proxy"]);
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));

    act(() => {
      listeners["log-read"]!(readEvent("app", 0));
      listeners["stream-failed"]!({
        payload: {
          stream_id: "stream-proxy",
          kind: "no-previous-run",
          message: "no previous run",
        },
      });
    });

    expect(result.current.previousRead).toEqual({ sources: 1, lines: 0 });
  });

  /** Fails if a followed pane, which never ends, is ever given a read to judge. */
  it("has no read to speak of on a followed pane", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    act(() => listeners["log-read"]?.(readEvent("c", 0)));
    expect(result.current.previousRead).toBeNull();
  });
});

/**
 * One lane of a workload pane, attached again by the reader. It reads on
 * from the last line it said: opened like a pod that had just joined, with
 * no tail, everything it wrote while it was down was skipped with no mark.
 */
describe("useLogStream attaching one lane again", () => {
  const A = { pod: "api-a", namespace: "n", container: "app" };
  const B = { pod: "api-b", namespace: "n", container: "app" };
  const at = (second: number, message: string) => ({
    message,
    timestamp: `2026-10-07T06:52:${String(second).padStart(2, "0")}.500Z`,
    level: null,
    format: null,
    fields: null,
    raw: message,
  });
  const fromA = (...lines: ReturnType<typeof at>[]) =>
    act(() =>
      listeners["log-batch"]!({
        payload: { stream_id: "stream-api-a-app", lines },
      })
    );
  const lanes = (previous = false) =>
    renderHook(() =>
      useLogStream({
        namespace: "n",
        sources: [A, B],
        paneKey: "Deployment:api",
        limit: DEFAULT_LOG_LIMIT,
        previous,
      })
    );
  const broke = () =>
    act(() =>
      listeners["stream-failed"]!({
        payload: {
          stream_id: "stream-api-a-app",
          kind: "broken",
          message: "connection reset",
        },
      })
    );
  const again = async (result: {
    current: ReturnType<typeof useLogStream>;
  }) => {
    act(() => result.current.retrySource("api-a", "app"));
    await waitFor(() => expect(subscribedCalls).toHaveLength(3));
    return streamConfigs[2];
  };

  beforeEach(() => {
    reset();
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      streamConfigs.push(config);
      return `stream-${config.podName}-${config.container}`;
    });
  });
  afterEach(() => vi.useRealTimers());

  /** Fails if the lane is opened from now, which skips what the pod wrote while its stream was down. */
  it("reads on from the last line the lane said", async () => {
    const { result } = lanes();
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    fromA(at(9, "before the break"));
    broke();

    const config = await again(result);

    expect(config).toMatchObject({
      podName: "api-a",
      sinceTime: "2026-10-07T06:52:09.500Z",
      tailLines: DEFAULT_LOG_LIMIT,
    });
  });

  /**
   * The node answers from the instant asked for, so the lines of that
   * instant come again. Fails if they are drawn twice, or if a new line
   * written in the same instant is taken for one of them and dropped.
   */
  it("does not repeat what it already holds of the instant it reads on from", async () => {
    const { result } = lanes();
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    fromA(at(8, "earlier"), at(9, "before the break"));
    await waitFor(() => expect(result.current.logs).toHaveLength(2));
    broke();
    await again(result);
    holdTheClock();

    fromA(
      at(8, "earlier"),
      at(9, "before the break"),
      at(9, "written in the same instant"),
      at(12, "written while it was down"),
      at(12, "written while it was down")
    );
    await pastTheWindow();

    expect(result.current.logs.map((line) => line.message)).toEqual([
      "earlier",
      "before the break",
      "written in the same instant",
      "written while it was down",
      "written while it was down",
    ]);
  });

  /** A lane that broke before its first line has no last line. Fails if it reads on from now and skips what it wrote since the pane opened. */
  it("reads a lane that never said a line on from when the pane opened", async () => {
    const opened = Date.now();
    const { result } = lanes();
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    broke();

    const config = await again(result);

    expect(config.tailLines).toBe(DEFAULT_LOG_LIMIT);
    expect(Date.parse(config.sinceTime!)).toBeGreaterThanOrEqual(opened);
    expect(Date.parse(config.sinceTime!)).toBeLessThanOrEqual(Date.now());
  });

  /**
   * A previous run is finished: asked for no lines, it answers with none and
   * the lane read as read. Fails if it is not read again with its share, or
   * if the pane takes the read for over before it has ended.
   */
  it("reads a previous run again, and has not read it until that ends", async () => {
    const { result } = lanes(true);
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    act(() =>
      listeners["log-read"]!({
        payload: { stream_id: "stream-api-b-app", lines: 4 },
      })
    );
    broke();
    expect(result.current.previousRead).toEqual({ sources: 1, lines: 4 });

    const config = await again(result);

    expect(config).toMatchObject({
      podName: "api-a",
      previous: true,
      tailLines: streamConfigs[0].tailLines,
      sinceTime: null,
    });
    expect(config.tailLines).toBeGreaterThan(0);
    expect(result.current.previousRead).toBeNull();
  });

  /** The rule for a pod that joins is not this one. Fails if a lane nobody asked to attach again reads from anywhere but now. */
  it("still opens a pod that joins from now", async () => {
    const { rerender } = renderHook(
      ({ sources }) =>
        useLogStream({
          namespace: "n",
          sources,
          paneKey: "Deployment:api",
          limit: DEFAULT_LOG_LIMIT,
        }),
      { initialProps: { sources: [A] } }
    );
    await waitFor(() => expect(subscribedCalls).toHaveLength(1));
    rerender({ sources: [A, B] });
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));

    expect(streamConfigs[1]).toMatchObject({ tailLines: 0, sinceTime: null });
  });
});

/**
 * More than a thousand events ahead of the bridge and it drops the oldest,
 * whichever they were: a batch of lines, a lane's failure, the end of a
 * previous run's read. The pane cannot know which, so it reads every lane on
 * from its last line.
 */
describe("useLogStream when the event bridge drops events", () => {
  const A = { pod: "api-a", namespace: "n", container: "app" };
  const B = { pod: "api-b", namespace: "n", container: "app" };
  const lanes = (previous = false) =>
    renderHook(() =>
      useLogStream({
        namespace: "n",
        sources: [A, B],
        paneKey: "Deployment:api",
        limit: DEFAULT_LOG_LIMIT,
        previous,
      })
    );
  const lagged = () =>
    act(() => listeners["event-bridge-lagged"]!({ payload: { missed: 1200 } }));

  beforeEach(() => {
    reset();
    vi.mocked(commands.streamPodLogs).mockImplementation(async (config) => {
      streamConfigs.push(config);
      return `stream-${config.podName}-${config.container}`;
    });
  });

  /**
   * Lines were missing with no mark, and a lane whose failure was dropped
   * read "streaming" for good. Fails if a lane is not stopped and read on
   * from its last line, which is what finds both.
   */
  it("attaches every lane again, each from the last line it said", async () => {
    lanes();
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    act(() =>
      listeners["log-batch"]!({
        payload: {
          stream_id: "stream-api-a-app",
          lines: [
            {
              message: "last heard",
              timestamp: "2026-10-07T06:52:09.500Z",
              level: null,
              format: null,
              fields: null,
              raw: "last heard",
            },
          ],
        },
      })
    );

    lagged();
    await waitFor(() => expect(subscribedCalls).toHaveLength(4));

    expect(commands.stopLogStream).toHaveBeenCalledWith("stream-api-a-app");
    expect(commands.stopLogStream).toHaveBeenCalledWith("stream-api-b-app");
    const again = streamConfigs.slice(2);
    expect(again.find((c) => c.podName === "api-a")).toMatchObject({
      sinceTime: "2026-10-07T06:52:09.500Z",
      tailLines: DEFAULT_LOG_LIMIT,
    });
    expect(again.find((c) => c.podName === "api-b")?.sinceTime).not.toBeNull();
  });

  /** A lane the pane already says stopped is not followed again behind the reader's back. Fails if a lag reopens it. */
  it("leaves a lane that had already stopped as it was", async () => {
    const { result } = lanes();
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    act(() =>
      listeners["stream-failed"]!({
        payload: {
          stream_id: "stream-api-a-app",
          kind: "gone",
          message: "pod deleted",
        },
      })
    );

    lagged();
    await waitFor(() => expect(subscribedCalls).toHaveLength(3));

    expect(streamConfigs[2].podName).toBe("api-b");
    expect(result.current.failures).toMatchObject([{ pod: "api-a" }]);
  });

  /**
   * The end of a previous run's read may be among what was dropped, and so
   * may its lines. Fails if a read counted as over stays over while it is
   * being read again.
   */
  it("takes a previous run's read as not over until it ends again", async () => {
    const { result } = lanes(true);
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));
    act(() => {
      for (const pod of ["api-a", "api-b"])
        listeners["log-read"]!({
          payload: { stream_id: `stream-${pod}-app`, lines: 2 },
        });
    });
    expect(result.current.previousRead).toEqual({ sources: 2, lines: 4 });

    lagged();
    await waitFor(() => expect(subscribedCalls).toHaveLength(4));

    expect(result.current.previousRead).toBeNull();
  });

  /** A burst lags the bridge again and again. Fails if each lag stacks another round of streams on the one being opened. */
  it("opens one round of streams for a run of lags", async () => {
    lanes();
    await waitFor(() => expect(subscribedCalls).toHaveLength(2));

    lagged();
    lagged();
    lagged();
    await waitFor(() => expect(subscribedCalls).toHaveLength(4));
    await act(async () => {});

    expect(streamConfigs).toHaveLength(4);
  });
});
