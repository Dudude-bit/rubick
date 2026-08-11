import { describe, it, expect, vi, beforeEach } from "vitest";
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

vi.mock("@/lib/error-utils", () => ({
  normalizeTauriError: (err: unknown) => String(err),
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

/** Wait past the reorder window so a released batch has been committed. */
const settled = (n: number) => ({ timeout: 500 + n });

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

    act(() => {
      listeners["log-batch"]!(logEvent("web", "GET /checkout 200"));
      listeners["log-batch"]!(logEvent("sidecar", "proxying upstream"));
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    }, settled(REORDER_WINDOW_MS));

    expect(result.current.logs.map((l) => l.container)).toEqual([
      "web",
      "sidecar",
    ]);
  });

  it("orders one reorder window by timestamp, not by arrival", async () => {
    // Two live streams do not arrive in timestamp order. Everything
    // that lands inside one window is emitted ordered; the guarantee
    // stops at the window edge, which the next test pins down.
    const { result } = renderHook(() =>
      useLogStream({ ...baseProps, containers: ["web", "sidecar"] })
    );

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(2);
    });

    act(() => {
      listeners["log-batch"]!(
        logEvent("web", {
          message: "later",
          timestamp: "2026-08-06T10:00:02.000Z",
        })
      );
      listeners["log-batch"]!(
        logEvent("sidecar", {
          message: "earlier",
          timestamp: "2026-08-06T10:00:01.000Z",
        })
      );
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    }, settled(REORDER_WINDOW_MS));

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

    act(() => {
      listeners["log-batch"]!(
        logEvent("web", {
          message: "committed first",
          timestamp: "2026-08-06T10:00:02.000Z",
        })
      );
    });
    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    }, settled(REORDER_WINDOW_MS));

    act(() => {
      listeners["log-batch"]!(
        logEvent("sidecar", {
          message: "arrived late",
          timestamp: "2026-08-06T10:00:01.000Z",
        })
      );
    });
    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    }, settled(REORDER_WINDOW_MS));

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

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(3);
    }, settled(REORDER_WINDOW_MS));

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

    act(() => {
      listeners["log-batch"]!(
        logEvent("c", "flood line 643585 done", "flood line 643586 done")
      );
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    }, settled(REORDER_WINDOW_MS));

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

    const batch = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    act(() => {
      for (let i = 0; i < 6; i++) {
        listeners["log-batch"]!(logEvent("c", ...batch));
      }
    });

    await waitFor(() => {
      expect(result.current.retained).toBe(limit);
    }, settled(REORDER_WINDOW_MS));

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

    act(() => {
      listeners["log-batch"]!(logEvent("c", "one", "two"));
    });

    await waitFor(() => {
      expect(result.current.retained).toBe(2);
    }, settled(REORDER_WINDOW_MS));
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
          "n/p stopped streaming — container c is no longer running."
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

    act(() => {
      listeners["log-batch"]!(logEvent("json-logger", "still alive"));
    });
    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    }, settled(REORDER_WINDOW_MS));
  });

  it("ignores a failure belonging to a stream it does not own", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    act(() => {
      listeners["stream-failed"]!(
        failureEvent("someone-else", "broken", "not ours")
      );
      listeners["log-batch"]!(logEvent("c", "still alive"));
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    }, settled(REORDER_WINDOW_MS));
    expect(result.current.failures).toHaveLength(0);
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

    act(() => {
      listeners["log-batch"]!(logEvent("c", "first"));
      listeners["log-batch"]!(logEvent("c", "second", "third"));
    });

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(3);
    }, settled(REORDER_WINDOW_MS));

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

    act(() => {
      listeners["log-batch"]!(logEvent("c", "alpha", "beta"));
    });
    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    }, settled(REORDER_WINDOW_MS));
    const idsBefore = result.current.logs.map((l) => l.id);

    act(() => {
      listeners["log-batch"]!(logEvent("c", "gamma"));
    });
    await waitFor(() => {
      expect(result.current.logs).toHaveLength(3);
    }, settled(REORDER_WINDOW_MS));

    expect(result.current.logs[0].id).toBe(idsBefore[0]);
    expect(result.current.logs[1].id).toBe(idsBefore[1]);
  });
});
