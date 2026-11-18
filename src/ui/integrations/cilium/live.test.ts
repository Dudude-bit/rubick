// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { waitFor } from "@testing-library/react";

import { forgetChannels } from "@/lib/events";
import type { LiveBatch } from "@/lib/traffic";
import { openLiveFlows } from "./live";

type Handler = (event: { payload: unknown }) => void;

const calls = vi.hoisted(() => ({
  order: [] as string[],
  listeners: {} as Record<string, Handler>,
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
    openHubbleFlows: vi.fn(async () => {
      calls.order.push("open");
      return "hubble-1";
    }),
    hubbleFlowsSubscribed: vi.fn(async (id: string) => {
      calls.order.push(`subscribed:${id}`);
    }),
    closeHubbleFlows: vi.fn(async (id: string) => {
      calls.closed.push(id);
    }),
  },
}));

const emit = (channel: string, payload: object) =>
  calls.listeners[channel]?.({ payload: { channel, ...payload } });

beforeEach(() => {
  calls.order.length = 0;
  calls.closed.length = 0;
  for (const key of Object.keys(calls.listeners)) delete calls.listeners[key];
  forgetChannels();
});
afterEach(() => vi.clearAllMocks());

describe("a live stream from Hubble Relay", () => {
  /**
   * Tauri events have no replay: both listeners are up before the stream
   * is opened, and it is let go only after that.
   */
  it("listens before it opens and is released after", async () => {
    openLiveFlows(null, { batch: () => {}, ended: () => {}, failed: () => {} });
    await waitFor(() => expect(calls.order).toContain("subscribed:hubble-1"));
    const open = calls.order.indexOf("open");
    expect(calls.order.indexOf("listen:hubble-flows")).toBeLessThan(open);
    expect(calls.order.indexOf("listen:hubble-flows-ended")).toBeLessThan(open);
    expect(calls.order.indexOf("subscribed:hubble-1")).toBeGreaterThan(open);
  });

  /** Only its own stream's batches are taken, and leaving closes it. */
  it("takes only its own stream's batches and closes when left", async () => {
    const batches: LiveBatch[] = [];
    const ended: string[] = [];
    const stop = openLiveFlows(["shop"], {
      batch: (batch) => batches.push(batch),
      ended: (end) => ended.push(end.says),
      failed: () => {},
    });
    await waitFor(() => expect(calls.order).toContain("subscribed:hubble-1"));
    const batch = {
      pairs: [],
      gone: [],
      relay: null,
      lost: 2,
      untracked: 0,
      waiting: 3,
      unreached: [],
    };
    emit("hubble-flows", { stream_id: "other", ...batch });
    emit("hubble-flows", { stream_id: "hubble-1", ...batch });
    emit("hubble-flows-ended", {
      stream_id: "hubble-1",
      end: { says: "notEnabled" },
    });
    expect(batches.map((b) => b.lost)).toEqual([2]);
    expect(batches[0].waiting).toBe(3);
    expect(batches[0].unreached).toEqual([]);
    expect(ended).toEqual(["notEnabled"]);
    stop();
    expect(calls.closed).toEqual(["hubble-1"]);
  });
});
