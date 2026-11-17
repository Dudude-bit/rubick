import { describe, expect, it } from "vite-plus/test";

import type { FlowEnd, TopologyNode } from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import { MEASURES, pairRows, type TrafficReading } from "@/lib/traffic";
import { nodeId } from "../-map/ids";
import { newMemo, OWNERLESS } from "../-topology/model";
import { trafficModel } from "./model";

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
  nodes: TopologyNode[]
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
      },
    ],
    window: "5m",
    answer: {
      ends,
      flows: pairs.map(([from, to]) => ({
        source: 0,
        from,
        to,
        protocols: [],
        values: MEASURES.map((m) => (m === "requests" ? 1 : null)),
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
        flow: "forward",
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

  /** A workload calling itself is a row, and no line from a node to itself. */
  it("draws no line from a node to itself", () => {
    const drawn = model(
      [workload("Deployment", "cart")],
      [[0, 0]],
      [mapped("Deployment", "cart", "apps")]
    );
    expect(drawn.edges).toEqual([]);
  });
});
