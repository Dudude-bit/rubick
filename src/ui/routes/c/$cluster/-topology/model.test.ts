import { describe, expect, it } from "vite-plus/test";

import type {
  MapKindState,
  NamespaceRead,
  TopologyEdge,
  TopologyNode,
} from "@/generated/types";
import { translate } from "@/i18n";
import type { T } from "@/i18n/useT";
import {
  modelOf,
  newMemo,
  notLookedAt,
  OWNERLESS,
  type ModelSettings,
} from "./model";
import { topologySection } from "./topology-share";

const t: T = (section, key, values) => translate("en", section, key, values);

const node = (
  kind: string,
  name: string,
  namespace = "shop",
  app: string | null = null
): TopologyNode => ({
  id: `/${kind}/${namespace}/${name}`,
  ref: { kind, name, namespace, existence: "present", facts: null },
  home: namespace,
  verdict: { says: "exists" },
  app,
  pods: null,
  cover: null,
  labels: {},
  annotations: {},
});

const read = (namespace: string, refused = false): NamespaceRead => ({
  namespace,
  counts: [{ kind: "Service", count: refused ? null : 1, used: null }],
  notLookedAt: refused
    ? [
        {
          kind: "Service",
          why: {
            says: "unanswered",
            version: "v1",
            said: "services is forbidden",
          },
        },
      ]
    : [],
});

const settings = (over: Partial<ModelSettings> = {}): ModelSettings => ({
  grouping: "namespace",
  hidden: new Set(),
  policies: false,
  toggled: new Map(),
  collapsedAtFirst: false,
  ...over,
});

const of = (
  nodes: TopologyNode[],
  reads: NamespaceRead[],
  edges: TopologyEdge[] = [],
  over: Partial<ModelSettings> = {}
) =>
  modelOf(
    new Map(nodes.map((each) => [each.id, each])),
    new Map(edges.map((each) => [each.id, each])),
    new Map(reads.map((each) => [each.namespace, each])),
    settings(over),
    () => "mute",
    t
  );

describe("the cluster map's model", () => {
  /** A namespace nobody could read anything in is drawn refused, in the cluster's words. Drawn as an empty card, it reads as a namespace with nothing in it. */
  it("draws a namespace whose every read was refused as refused, not empty", () => {
    const model = of([], [read("shop", true), read("billing")]);
    const shop = model.groups.find((group) => group.id === "shop")!;
    expect(shop.refused).toBe(true);
    expect(shop.tone).toBe("unknown");
    expect(model.summaries.get("shop")).toContain("services is forbidden");
    expect(model.groups.find((group) => group.id === "billing")!.refused).toBe(
      false
    );
  });

  /** A hidden kind leaves the map with its edges, and NetworkPolicies wait for the overlay. */
  it("leaves out hidden kinds, and NetworkPolicies until the overlay is on", () => {
    const nodes = [
      node("Deployment", "cart"),
      node("ServiceAccount", "cart"),
      node("NetworkPolicy", "only-front"),
    ];
    const edges: TopologyEdge[] = [
      {
        id: "a",
        from: nodes[0].id,
        to: nodes[1].id,
        relations: [{ verb: "uses", usages: [] }],
      },
    ];
    const hidden = of(nodes, [read("shop")], edges, {
      hidden: new Set(["ServiceAccount"]),
    });
    expect(hidden.nodes.map((each) => each.kind)).toEqual(["Deployment"]);
    expect(hidden.edges).toEqual([]);
    const overlay = of(nodes, [read("shop")], edges, { policies: true });
    expect(overlay.nodes.map((each) => each.kind)).toContain("NetworkPolicy");
  });

  /** By app, an object with no app label falls in its namespace's own group, named for what it lacks. */
  it("groups by app, and names the group of what carries none", () => {
    const model = of(
      [
        node("Deployment", "cart", "shop", "store"),
        node("Deployment", "cron", "shop"),
      ],
      [read("shop")],
      [],
      { grouping: "app" }
    );
    expect(model.groups.map((group) => group.label)).toEqual([
      "store",
      "shop · no app label",
    ]);
  });

  /** A batch that replaced one object redraws that one: every other node stays the object the canvas memoised, or a pod restarting redraws the cluster. */
  it("keeps the drawing of every node a batch did not replace", () => {
    const memo = newMemo();
    const cart = node("Deployment", "cart");
    const web = node("Service", "web");
    const read = (nodes: TopologyNode[]) =>
      modelOf(
        new Map(nodes.map((each) => [each.id, each])),
        new Map(),
        new Map(),
        settings(),
        () => "mute",
        t,
        memo
      );
    const first = read([cart, web]);
    const again = read([cart, { ...web, app: "shop" }]);
    const drawn = (model: typeof first, id: string) =>
      model.nodes.find((each) => each.id === id);
    expect(drawn(again, cart.id)).toBe(drawn(first, cart.id));
    expect(drawn(again, web.id)).not.toBe(drawn(first, web.id));
  });

  /** The pods nothing owns are one node, named as such rather than as a pod called "*". */
  it("names the node of pods with no owner", () => {
    const model = of([node("Pod", OWNERLESS)], [read("shop")]);
    expect(model.nodes[0].label).toBe("Pods with no owner");
  });

  /** A Service list refused takes every routing and selection edge with it; the map says those edges are absent rather than leaving them out quietly. */
  it("says which absent edges a refused kind took with it", () => {
    const kinds: MapKindState[] = [
      {
        kind: "Service",
        reading: { says: "refused", said: "services is forbidden" },
      },
      {
        kind: "Secret",
        reading: { says: "refused", said: "secrets is forbidden" },
      },
      { kind: "Deployment", reading: { says: "live" } },
      { kind: "HTTPRoute", reading: { says: "notServed" } },
    ];
    const lines = notLookedAt(kinds, t);
    expect(lines.map((line) => [line.kind, line.edges])).toEqual([
      ["Service", true],
      ["Secret", false],
    ]);
    expect(lines[0].line).toContain("services is forbidden");
  });

  /** Share carries a row a group and names what was not read above the rows, so the file never reads as a smaller cluster. */
  it("shares a row a group and names what was not read", () => {
    const model = of(
      [node("Deployment", "cart")],
      [read("shop"), read("billing")]
    );
    const section = topologySection(model, ["Secret"], t, "By namespace");
    expect(section.body.type).toBe("table");
    if (section.body.type !== "table") return;
    expect(section.body.rows.map((row) => row.cells[0].text)).toEqual([
      "billing",
      "shop",
    ]);
    expect(section.partial).toContain("Secret");
  });
});
