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
    store.apply([{ is: "node", node: node("data", "Bound") }]);
    const nodes = store.snapshot().nodes;
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
});
