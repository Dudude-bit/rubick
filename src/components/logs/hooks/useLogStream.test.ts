import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// ----- Mocks -----

// Order tracking shared between the listen mock and the
// logStreamSubscribed mock so we can assert the contract: the listener
// for "log-batch" MUST be installed before logStreamSubscribed is called.

let callCounter = 0;
const listenCalls: Array<{ event: string; index: number }> = [];
const subscribedCalls: Array<{ streamId: string; index: number }> = [];

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
    streamPodLogs: vi.fn(async () => "stream-id-1"),
    stopLogStream: vi.fn(async () => undefined),
    logStreamSubscribed: vi.fn(async (streamId: string) => {
      subscribedCalls.push({ streamId, index: callCounter++ });
    }),
  },
}));

vi.mock("@/lib/error-utils", () => ({
  normalizeTauriError: (err: unknown) => String(err),
}));

import {
  appendCapped,
  MAX_LOG_LINES,
  useLogStream,
  type StreamedLogLine,
} from "./useLogStream";

const baseProps = {
  podName: "p",
  namespace: "n",
  container: "c",
  tailLines: 100,
};

describe("useLogStream deferred-start handshake", () => {
  beforeEach(() => {
    listenCalls.length = 0;
    subscribedCalls.length = 0;
    callCounter = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("registers log-batch listener before calling logStreamSubscribed", async () => {
    renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const batchCall = listenCalls.find((c) => c.event === "log-batch");
    expect(batchCall, "log-batch listener was never registered").toBeDefined();
    expect(batchCall!.index).toBeLessThan(subscribedCalls[0].index);
  });

  it("registers stream-failed listener before calling logStreamSubscribed", async () => {
    // Same contract as log-batch, and for the same reason: the backend
    // can fail on its first read the moment the gate is released, and
    // Tauri events have no replay.
    renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const failureCall = listenCalls.find((c) => c.event === "stream-failed");
    expect(
      failureCall,
      "stream-failed listener was never registered"
    ).toBeDefined();
    expect(failureCall!.index).toBeLessThan(subscribedCalls[0].index);
  });

  it("calls logStreamSubscribed with the streamId returned from streamPodLogs", async () => {
    renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    expect(subscribedCalls[0].streamId).toBe("stream-id-1");
  });
});

// Helper: build a log-batch event payload of the shape the backend emits.
// The streamer flushes every 50ms (or every 100 lines), so each event
// carries an array. Most tests just send one-line batches.
function logEvent(streamId: string, ...messages: string[]) {
  return {
    payload: {
      stream_id: streamId,
      lines: messages.map((message) => ({
        message,
        timestamp: null,
        level: null,
        format: null,
        fields: null,
        raw: message,
      })),
    },
  };
}

function failureEvent(
  streamId: string,
  kind: "gone" | "broken",
  message: string
) {
  return { payload: { stream_id: streamId, kind, message } };
}

describe("useLogStream surfaces a stream that dies after it started", () => {
  beforeEach(() => {
    listenCalls.length = 0;
    subscribedCalls.length = 0;
    callCounter = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("reports a deleted pod as gone and stops claiming to stream", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });
    expect(result.current.failure).toBeNull();

    listeners["stream-failed"]!(
      failureEvent(
        "stream-id-1",
        "gone",
        "n/p stopped streaming — container c is no longer running."
      )
    );

    await waitFor(() => {
      expect(result.current.failure).not.toBeNull();
    });
    expect(result.current.failure!.kind).toBe("gone");
    expect(result.current.failure!.message).toContain("no longer running");
    expect(result.current.isStreaming).toBe(false);
  });

  it("reports a dropped connection as broken", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    listeners["stream-failed"]!(
      failureEvent("stream-id-1", "broken", "The log stream from n/p broke.")
    );

    await waitFor(() => {
      expect(result.current.failure?.kind).toBe("broken");
    });
  });

  it("ignores a failure belonging to another stream", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    listeners["stream-failed"]!(
      failureEvent("some-other-stream", "broken", "not ours")
    );
    listeners["log-batch"]!(logEvent("stream-id-1", "still alive"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(1);
    });
    expect(result.current.failure).toBeNull();
  });

  it("clears the failure when retry restarts the stream", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    listeners["stream-failed"]!(
      failureEvent("stream-id-1", "broken", "dropped")
    );
    await waitFor(() => {
      expect(result.current.failure).not.toBeNull();
    });

    act(() => {
      result.current.retry();
    });

    await waitFor(() => {
      expect(result.current.failure).toBeNull();
    });
  });
});

describe("useLogStream stable line ids", () => {
  beforeEach(() => {
    listenCalls.length = 0;
    subscribedCalls.length = 0;
    callCounter = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("assigns a unique, monotonically increasing id to each log line", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const handler = listeners["log-batch"];
    expect(handler, "log-batch handler captured").toBeDefined();

    handler!(logEvent("stream-id-1", "first"));
    handler!(logEvent("stream-id-1", "second"));
    handler!(logEvent("stream-id-1", "third"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(3);
    });

    const ids = result.current.logs.map((l) => l.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBeLessThan(ids[1]);
    expect(ids[1]).toBeLessThan(ids[2]);
  });

  it("expands a batched event into one log entry per line", async () => {
    // Backend flushes every ~50ms, so a single Tauri event commonly
    // carries multiple lines. Each one must become its own log entry
    // with its own unique id, in arrival order.
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const handler = listeners["log-batch"]!;
    handler(logEvent("stream-id-1", "one", "two", "three", "four"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(4);
    });

    expect(result.current.logs.map((l) => l.message)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    const ids = result.current.logs.map((l) => l.id);
    expect(new Set(ids).size).toBe(4);
  });

  it("preserves ids across renders so React keys stay stable", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const handler = listeners["log-batch"]!;
    handler(logEvent("stream-id-1", "alpha"));
    handler(logEvent("stream-id-1", "beta"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(2);
    });

    const idsBefore = result.current.logs.map((l) => l.id);

    // Append more logs — the existing entries' ids must not change.
    handler(logEvent("stream-id-1", "gamma"));

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(3);
    });

    expect(result.current.logs[0].id).toBe(idsBefore[0]);
    expect(result.current.logs[1].id).toBe(idsBefore[1]);
  });
});

describe("appendCapped", () => {
  const line = (id: number) => ({ id, message: `m${id}` }) as StreamedLogLine;
  const lines = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => line(from + i));

  it("returns a new array so React sees the change", () => {
    const prev = lines(0, 3);
    const next = appendCapped(prev, lines(3, 2));
    expect(next).not.toBe(prev);
    expect(prev).toHaveLength(3);
    expect(next.map((l) => l.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("drops from the head once the cap is reached, keeping the newest", () => {
    const prev = lines(0, MAX_LOG_LINES);
    const next = appendCapped(prev, lines(MAX_LOG_LINES, 10));

    expect(next).toHaveLength(MAX_LOG_LINES);
    expect(next[0].id).toBe(10);
    expect(next[next.length - 1].id).toBe(MAX_LOG_LINES + 9);
  });

  it("keeps only the tail of a batch that is itself over the cap", () => {
    const next = appendCapped(lines(0, 5), lines(100, MAX_LOG_LINES + 20));

    expect(next).toHaveLength(MAX_LOG_LINES);
    expect(next[0].id).toBe(120);
    expect(next[next.length - 1].id).toBe(100 + MAX_LOG_LINES + 19);
  });
});

describe("useLogStream retention", () => {
  beforeEach(() => {
    listenCalls.length = 0;
    subscribedCalls.length = 0;
    callCounter = 0;
    for (const k of Object.keys(listeners)) delete listeners[k];
    vi.clearAllMocks();
  });

  it("never retains more than the cap, however many batches arrive", async () => {
    const { result } = renderHook(() => useLogStream(baseProps));

    await waitFor(() => {
      expect(subscribedCalls).toHaveLength(1);
    });

    const handler = listeners["log-batch"]!;
    const batch = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    for (let i = 0; i < MAX_LOG_LINES / 1000 + 3; i++) {
      handler(logEvent("stream-id-1", ...batch));
    }

    await waitFor(() => {
      expect(result.current.logs).toHaveLength(MAX_LOG_LINES);
    });

    // Ids stay strictly increasing across the drop, which is what the
    // virtualiser's per-line height cache is keyed on.
    const ids = result.current.logs.map((l) => l.id);
    expect(ids[0]).toBeLessThan(ids[ids.length - 1]);
    expect(new Set(ids).size).toBe(MAX_LOG_LINES);
  });
});
