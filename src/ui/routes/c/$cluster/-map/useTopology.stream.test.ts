// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { forgetChannels } from "@/lib/events";
import { useClusterStore } from "@/stores/clusterStore";
import { useTopology } from "./useTopology";

type Handler = (event: { payload: unknown }) => void;

const calls = vi.hoisted(() => ({
  order: [] as string[],
  listeners: {} as Record<string, Handler>,
  opened: 0,
  closed: [] as string[],
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
    openTopology: vi.fn(async () => `map-${++calls.opened}`),
    topologySubscribed: vi.fn(async (id: string) => {
      calls.order.push(`subscribed:${id}`);
    }),
    closeTopology: vi.fn(async (id: string) => {
      calls.closed.push(id);
    }),
  },
}));

const emit = (channel: string, payload: unknown) =>
  calls.listeners[channel]?.({ payload: { channel, ...(payload as object) } });

beforeEach(() => {
  calls.order.length = 0;
  calls.opened = 0;
  calls.closed.length = 0;
  for (const key of Object.keys(calls.listeners)) delete calls.listeners[key];
  forgetChannels();
  useClusterStore.setState({ currentContext: "kind-kind" });
});

afterEach(() => vi.useRealTimers());

describe("the map stream", () => {
  /** A batch sent before its listener exists has no replay: the map would be short by exactly that batch. */
  it("listens on every channel before it lets the stream flow", async () => {
    renderHook(() => useTopology(["shop"]));
    await waitFor(() => expect(calls.order).toContain("subscribed:map-1"));
    const gate = calls.order.indexOf("subscribed:map-1");
    for (const channel of [
      "topology-batch",
      "topology-ready",
      "topology-ended",
    ])
      expect(calls.order.indexOf(`listen:${channel}`)).toBeLessThan(gate);
  });

  /** A renewed credential replaces the cluster's client and ends the map; left ended, the screen would freeze on the old answer with no word about it. */
  it("opens again when the backend ends the stream as replaced", async () => {
    const { result } = renderHook(() => useTopology(["shop"]));
    await waitFor(() => expect(calls.order).toContain("subscribed:map-1"));
    act(() =>
      emit("topology-ended", { stream_id: "map-1", end: { says: "replaced" } })
    );
    await waitFor(() => expect(calls.order).toContain("subscribed:map-2"));
    expect(result.current.phase).not.toBe("ended");
  });

  /** A batch for another window's stream is not this map's. */
  it("takes only its own stream's batches and closes the stream when it leaves", async () => {
    const { result, unmount } = renderHook(() => useTopology(["shop"]));
    await waitFor(() => expect(calls.order).toContain("subscribed:map-1"));
    const node = (id: string) => ({
      is: "node",
      node: {
        id,
        ref: {
          kind: "Service",
          name: id,
          namespace: "shop",
          existence: "present",
          facts: null,
        },
        home: "shop",
        verdict: { says: "exists" },
        app: null,
        pods: null,
        cover: null,
      },
    });
    act(() => {
      emit("topology-batch", { stream_id: "map-9", pieces: [node("theirs")] });
      emit("topology-batch", { stream_id: "map-1", pieces: [node("ours")] });
    });
    await waitFor(() => expect(result.current.nodes.has("ours")).toBe(true));
    expect(result.current.nodes.has("theirs")).toBe(false);
    unmount();
    await waitFor(() => expect(calls.closed).toEqual(["map-1"]));
  });
});
