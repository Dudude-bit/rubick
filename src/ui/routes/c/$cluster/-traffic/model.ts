/**
 * Flows on the map: the workloads and Services the topology already draws,
 * each in its own colour, joined by the flows between them; an end the map
 * does not hold is drawn as itself and says why.
 */
import type { FlowEnd, NamespaceRead, TopologyNode } from "@/generated/types";
import type { T } from "@/i18n/useT";
import type { MapTone } from "@/integrations";
import { flowTone, weights, type FlowRow } from "@/lib/traffic";
import type { GraphEdge, GraphGroup, GraphNode } from "../-map/types";
import { drawnCrd } from "@/lib/links";
import { nodeId } from "../-map/ids";
import { modelOf, OWNERLESS, type ModelMemo } from "../-topology/model";
import { endKind, endLabel, endSub, edgeSub } from "./traffic-words";

export interface TrafficModel {
  groups: GraphGroup[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The end each drawn node stands for. */
  endOf: ReadonlyMap<string, FlowEnd>;
  /** The row each drawn edge stands for. */
  rowOf: ReadonlyMap<string, FlowRow>;
}

/** The id the map draws an end under, if the map holds it. */
export function mapIdOf(
  end: FlowEnd,
  nodes: ReadonlyMap<string, TopologyNode>
): string | null {
  const id =
    end.is === "workload"
      ? nodeId({
          group: end.key.group,
          kind: end.key.kind,
          namespace: end.key.namespace,
          name: end.key.kind === "Pod" ? OWNERLESS : end.key.name,
        })
      : end.is === "service"
        ? nodeId({ kind: "Service", namespace: end.namespace, name: end.name })
        : null;
  return id !== null && nodes.has(id) ? id : null;
}

const homeOf = (end: FlowEnd): string | null => {
  switch (end.is) {
    case "workload":
      return end.key.namespace;
    case "ambiguous":
    case "notListed":
      return end.namespace;
    case "service":
    case "unidentified":
      return end.namespace;
    case "node":
    case "address":
    case "remote":
      return null;
  }
};

/**
 * What the last build handed the canvas, by id. The canvas draws an object
 * again only when it is a new one, so one that says the same is handed back
 * and a batch that moved one flow redraws one edge, not the map.
 */
export interface FlowMemo {
  groups: Map<string, GraphGroup>;
  nodes: Map<string, GraphNode>;
  edges: Map<string, GraphEdge>;
}

export const newFlowMemo = (): FlowMemo => ({
  groups: new Map(),
  nodes: new Map(),
  edges: new Map(),
});

const same = (a: object, b: object) => {
  const keys = Object.keys(a) as (keyof typeof a)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.is(a[key], b[key]))
  );
};

/** The objects of one kind, each the one handed out last where it says the same. */
function kept<Item extends { id: string }>(
  held: Map<string, Item>,
  items: readonly Item[]
): Item[] {
  const out = items.map((item) => {
    const was = held.get(item.id);
    return was && same(was, item) ? was : item;
  });
  held.clear();
  for (const item of out) held.set(item.id, item);
  return out;
}

export function trafficModel(input: {
  rows: readonly FlowRow[];
  nodes: ReadonlyMap<string, TopologyNode>;
  reads: ReadonlyMap<string, NamespaceRead>;
  toggled: ReadonlyMap<string, boolean>;
  collapsedAtFirst: boolean;
  toneOf: (node: TopologyNode) => MapTone;
  t: T;
  memo: ModelMemo;
  flows?: FlowMemo;
}): TrafficModel {
  const { rows, nodes, t } = input;
  const held = new Map<string, TopologyNode>();
  const standIns = new Map<string, FlowEnd>();
  const idOf = new Map<string, string>();
  const endOf = new Map<string, FlowEnd>();
  // A node several ends are drawn as (the namespace's pods nothing owns)
  // stands for none of them: opening it must not pick one.
  const shared = new Set<string>();
  for (const row of rows)
    for (const [end, key] of [
      [row.from, row.fromId],
      [row.to, row.toId],
    ] as const) {
      if (idOf.has(key)) continue;
      const mapped = mapIdOf(end, nodes);
      const node = mapped ? nodes.get(mapped) : undefined;
      const id = mapped && node ? mapped : `flow-end:${key}`;
      if (mapped && node) held.set(mapped, node);
      else standIns.set(id, end);
      idOf.set(key, id);
      if (endOf.has(id)) shared.add(id);
      endOf.set(id, end);
    }
  for (const id of shared) endOf.delete(id);

  const homes = new Set<string>();
  for (const node of held.values()) if (node.home) homes.add(node.home);
  for (const end of standIns.values()) {
    const home = homeOf(end);
    if (home) homes.add(home);
  }
  const reads = new Map(
    [...input.reads].filter(([namespace]) => homes.has(namespace))
  );
  const drawn = modelOf(
    held,
    new Map(),
    reads,
    {
      grouping: "namespace",
      hidden: new Set(),
      policies: false,
      toggled: input.toggled,
      collapsedAtFirst: input.collapsedAtFirst,
    },
    input.toneOf,
    t,
    input.memo
  );

  const groups = [...drawn.groups];
  const known = new Set(groups.map((group) => group.id));
  const standInNodes: GraphNode[] = [];
  for (const [id, end] of standIns) {
    const home = homeOf(end);
    if (home && !known.has(home)) {
      known.add(home);
      groups.push({
        id: home,
        label: home,
        collapsed: input.toggled.get(home) ?? input.collapsedAtFirst,
        tone: "unknown",
        summary: t("traffic", "groupNotOnMap"),
      });
    }
    standInNodes.push({
      id,
      group: home,
      kind: endKind(end),
      // A workload's own kind in its own group: a namesake of a built-in in
      // another group is drawn as a kind of its own, not with the built-in's glyph.
      crd: end.is === "workload" ? drawnCrd(end.key) : undefined,
      label: endLabel(end),
      sub: endSub(end, t),
      tone: "unknown",
      rank: 3,
    });
  }

  const weightOf = weights(rows);
  const edges: GraphEdge[] = [];
  const rowOf = new Map<string, FlowRow>();
  for (const row of rows) {
    const from = idOf.get(row.fromId);
    const to = idOf.get(row.toId);
    // A workload calling itself is a row in the table and no line on the map.
    if (!from || !to || from === to) continue;
    const id = `flow:${row.id}`;
    rowOf.set(id, row);
    edges.push({
      id,
      from,
      to,
      tone: flowTone(row),
      weight: weightOf.get(row.id) ?? 0,
      // Still: motion repaints the map every frame it moves. The page sets
      // the open flow moving; the stylesheet the one under the pointer.
      flow: "none",
      label: `${endLabel(row.from)} → ${endLabel(row.to)}`,
      sub: edgeSub(row, t),
    });
  }
  const flows = input.flows ?? newFlowMemo();
  return {
    groups: kept(flows.groups, groups),
    nodes: [...drawn.nodes, ...kept(flows.nodes, standInNodes)],
    edges: kept(flows.edges, edges),
    endOf,
    rowOf,
  };
}
