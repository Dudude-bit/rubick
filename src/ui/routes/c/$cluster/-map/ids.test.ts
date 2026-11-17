import { describe, expect, it } from "vite-plus/test";

import corpus from "../../../../../contracts/topology-ids.json";
import { nodeId } from "./ids";

describe("a node's id", () => {
  /** The Traffic page looks a workload a flow names up by this id: spelled differently from the backend's, every flow points at no node. */
  it("is spelled as the backend spells it for every case in the shared corpus", () => {
    expect(corpus.length).toBeGreaterThan(0);
    for (const entry of corpus)
      expect(
        nodeId({
          group: entry.group,
          kind: entry.kind,
          namespace: entry.namespace,
          name: entry.name,
        }),
        entry.id
      ).toBe(entry.id);
  });
});
