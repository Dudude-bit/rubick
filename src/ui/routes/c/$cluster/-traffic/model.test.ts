import { describe, expect, it } from "vite-plus/test";

import type { FlowEnd, TopologyNode } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { MEASURES, pairRows, type TrafficReading } from "@/lib/traffic";
import { nodeId } from "../-map/ids";
import { newMemo, OWNERLESS } from "../-topology/model";
import { newFlowMemo, trafficModel, type FlowMemo } from "./model";

const t: T = (section, key, values) => translate("en", section, key, values);

const mapped = (kind: string, name: string, group?: string): TopologyNode => ({
  id: nodeId({ group, kind, namespace: "shop", name }),
  ref: {
    group,
    kind,
    name,
    namespace: "shop",
    existence: "present",
    facts: null,
  },
  home: "shop",
  verdict: { says: "exists" },
  app: null,
  pods: null,
  cover: null,
  labels: {},
  annotations: {},
});

const workload = (kind: string, name: string, namespace = "shop"): FlowEnd => ({
  is: "workload",
  key: { namespace, group: kind === "Pod" ? "" : "apps", kind, name },
});

function model(
  ends: FlowEnd[],
  pairs: [number, number][],
  nodes: TopologyNode[],
  flows: FlowMemo = newFlowMemo(),
  requests: (pair: number) => number = () => 1
) {
  const reading: TrafficReading = {
    sources: [
      {
        id: "istio",
        name: "Istio",
        state: { says: "present" },
        measures: ["requests"],
        found: [],
        need: "needIstio",
        marks: true,
        nodeAgent: false,
        needsPods: false,
        grpcErrors: true,
      },
    ],
    window: "5m",
    answer: {
      ends,
      flows: pairs.map((pair) => ({
        from: pair[0],
        to: pair[1],
        source: 0,
        protocols: [],
        sides: [],
        values: MEASURES.map((m) =>
          m === "requests" ? requests(pairs.indexOf(pair)) : null
        ),
        reasons: [],
      })),
      reads: [],
      observed: null,
      coverage: [],
      podsUnread: [],
      podsFailed: null,
      cut: 0,
    },
  };
  return trafficModel({
    rows: pairRows(reading).rows,
    nodes: new Map(nodes.map((node) => [node.id, node])),
    reads: new Map(),
    toggled: new Map(),
    collapsedAtFirst: false,
    toneOf: () => "ok",
    t,
    memo: newMemo(),
    flows,
  });
}

describe("flows on the map", () => {
  /**
   * An end the map holds is the map's own node, coloured as its page
   * colours it; a bare pod is the namespace's node of ownerless pods.
   */
  it("draws an end the map holds as the map's node, and a bare pod as the ownerless one", () => {
    const cart = mapped("Deployment", "cart", "apps");
    const loose = mapped("Pod", OWNERLESS);
    const drawn = model(
      [workload("Deployment", "cart"), workload("Pod", "debug-x1")],
      [[1, 0]],
      [cart, loose]
    );
    expect(drawn.edges).toEqual([
      expect.objectContaining({
        from: loose.id,
        to: cart.id,
        tone: "mute",
        flow: "none",
      }),
    ]);
    expect(drawn.nodes.find((node) => node.id === cart.id)?.tone).toBe("ok");
  });

  /**
   * An end the map does not hold is drawn as itself, in its namespace's
   * card, with the not-checked ring: never dropped, never green.
   */
  it("draws an end the map does not hold as a stand-in with the not-checked ring", () => {
    const ambiguous: FlowEnd = {
      is: "ambiguous",
      namespace: "bank",
      name: "db",
      kinds: ["Deployment", "StatefulSet"],
    };
    const drawn = model(
      [workload("Deployment", "cart"), ambiguous],
      [[0, 1]],
      [mapped("Deployment", "cart", "apps")]
    );
    const standIn = drawn.nodes.find((node) => node.label === "db");
    expect(standIn).toMatchObject({ group: "bank", tone: "unknown" });
    expect(standIn?.sub).toContain("Deployment, StatefulSet");
    expect(drawn.groups.map((group) => group.id)).toContain("bank");
  });

  /**
   * A stand-in workload is drawn by its own kind and group: a namesake of a
   * built-in from another group is a kind of its own, the built-in itself
   * keeps its glyph.
   */
  it("draws a stand-in namesake as a kind of its own and a built-in with its glyph", () => {
    const namesake: FlowEnd = {
      is: "workload",
      key: {
        namespace: "shop",
        group: "custom.io",
        kind: "Deployment",
        name: "odd",
      },
    };
    const drawn = model(
      [workload("Deployment", "cart"), namesake],
      [[0, 1]],
      []
    );
    expect(drawn.nodes.find((node) => node.label === "odd")?.crd).toBeNull();
    expect(
      drawn.nodes.find((node) => node.label === "cart")?.crd
    ).toBeUndefined();
  });

  /** An address outside every namespace is drawn outside every card. */
  it("draws an address outside every card", () => {
    const drawn = model(
      [workload("Deployment", "cart"), { is: "address", address: "10.0.3.4" }],
      [[0, 1]],
      []
    );
    expect(
      drawn.nodes.find((node) => node.label === "10.0.3.4")?.group
    ).toBeNull();
  });

  /**
   * A workload in another cluster of the mesh is not this cluster's
   * namesake: its own node outside every card, saying its cluster.
   */
  it("draws an end in another cluster apart from its namesake here", () => {
    const web = mapped("Deployment", "web", "apps");
    const remote: FlowEnd = {
      is: "remote",
      cluster: "west",
      namespace: "shop",
      kind: "Deployment",
      name: "web",
    };
    const drawn = model(
      [remote, workload("Deployment", "web")],
      [[0, 1]],
      [web]
    );
    const there = drawn.nodes.find((node) => node.id !== web.id);
    expect(there).toMatchObject({ group: null, kind: "Deployment" });
    expect(there?.sub).toBe("shop in cluster west of the mesh");
    expect(drawn.edges[0]).toMatchObject({ from: there?.id, to: web.id });
  });

  /** A workload calling itself is a row, and no line from a node to itself. */
  it("draws no line from a node to itself", () => {
    const drawn = model(
      [workload("Deployment", "cart")],
      [[0, 0]],
      [mapped("Deployment", "cart", "apps")]
    );
    expect(drawn.edges).toEqual([]);
  });

  /**
   * Live redrew the whole map every second: each batch built every edge,
   * stand-in and card anew, and the canvas redraws what is new. One flow
   * that moved is one new edge; everything that says the same is handed back.
   */
  it("hands back every object a batch did not change, and a new one for the flow that moved", () => {
    const ends = [
      workload("Deployment", "cart"),
      workload("Deployment", "pay"),
      { is: "address", address: "10.0.3.4" } as FlowEnd,
    ];
    const pairs: [number, number][] = [
      [0, 1],
      [0, 2],
    ];
    const flows = newFlowMemo();
    const before = model(ends, pairs, [], flows, (pair) =>
      pair === 1 ? 10 : 1
    );
    const after = model(ends, pairs, [], flows, (pair) =>
      pair === 1 ? 10 : 2
    );
    expect(after.groups).toEqual(before.groups);
    after.groups.forEach((group, i) => expect(group).toBe(before.groups[i]));
    after.nodes.forEach((node, i) => expect(node).toBe(before.nodes[i]));
    expect(after.edges[1]).toBe(before.edges[1]);
    expect(after.edges[0]).not.toBe(before.edges[0]);
  });
});
