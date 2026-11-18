import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import type { TopologyNode } from "@/generated/types";
import { TopologyStore } from "./useTopology";

const node = (name: string, phase: string | null): TopologyNode => ({
  id: `/PersistentVolumeClaim/shop/${name}`,
  ref: {
    kind: "PersistentVolumeClaim",
    name,
    namespace: "shop",
    existence: "present",
    facts: null,
  },
  home: "shop",
  verdict: { says: "claim", phase },
  app: null,
  pods: null,
  cover: null,
  labels: {},
  annotations: {},
});

beforeEach(() => vi.stubGlobal("requestAnimationFrame", undefined));
afterEach(() => vi.unstubAllGlobals());

describe("what a map stream has sent", () => {
  /** A batch naming one claim must leave every other node the same object: a memoised node redrawn for nothing is the cost a delta exists to avoid. */
  it("replaces only the nodes a batch names and keeps the rest as they were", () => {
    const store = new TopologyStore();
    const data = node("data", "Pending");
    const logs = node("logs", "Bound");
    store.apply([
      { is: "node", node: data },
      { is: "node", node: logs },
    ]);
    const before = store.snapshot().nodes;
    store.apply([{ is: "node", node: node("data", "Bound") }]);
    const nodes = store.snapshot().nodes;
    // A reader memoised on the map has to see it move.
    expect(nodes).not.toBe(before);
    expect(nodes.get(logs.id)).toBe(logs);
    expect(nodes.get(data.id)).not.toBe(data);
    store.apply([{ is: "nodeGone", id: data.id }]);
    expect([...store.snapshot().nodes.keys()]).toEqual([logs.id]);
  });

  /** Opening, drawing, ready and ended are four states; a reader told "ready" before the scope was drawn whole would read a part as the cluster. */
  it("is drawing after a batch and ready only when the stream says so", () => {
    const store = new TopologyStore();
    expect(store.snapshot().phase).toBe("opening");
    store.apply([{ is: "kinds", kinds: [] }]);
    expect(store.snapshot().phase).toBe("drawing");
    store.ready();
    expect(store.snapshot().phase).toBe("ready");
    store.ended({ says: "replaced" });
    expect(store.snapshot()).toMatchObject({
      phase: "ended",
      end: { says: "replaced" },
    });
  });

  /**
   * Every group the reader had not toggled folded when a CronJob's Job took
   * the count past the line, and again on every reopen, when a reset set the
   * map back to opening. Fails if what the map held when first drawn whole
   * moves with a later count or is lost by a reset.
   */
  it("keeps what it held when first drawn whole through later batches and a reset", () => {
    const store = new TopologyStore();
    store.apply([{ is: "node", node: node("data", "Bound") }]);
    expect(store.snapshot().firstWhole).toBeNull();
    store.ready();
    expect(store.snapshot().firstWhole).toBe(1);
    store.apply([{ is: "node", node: node("logs", "Bound") }]);
    store.ready();
    expect(store.snapshot().firstWhole).toBe(1);
    store.reset();
    expect(store.snapshot()).toMatchObject({ phase: "opening", firstWhole: 1 });
  });
});
