import { useEffect, useMemo, useState } from "react";

import type {
  LayoutAnswer,
  LayoutGroupAsk,
  LayoutRequest,
  Point,
} from "@/lib/map-layout";
import { perf } from "@/lib/perf";
import type { GraphEdge, GraphGroup, GraphNode } from "./types";

export const NODE_W = 208;
export const NODE_H = 46;
export const CARD_W = 248;
export const CARD_H = 116;
/** Where the nodes in no group are laid out, beside the groups. */
export const OUTSIDE = "\u0000outside";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Placement {
  groups: ReadonlyMap<string, Box>;
  /** Relative to the node's group box. */
  nodes: ReadonlyMap<string, Point>;
  failed: string | null;
  /** Whether it answers what the canvas holds now, with no layout still being worked out. */
  settled: boolean;
}

interface Laid {
  signature: string;
  width: number;
  height: number;
  positions: Record<string, Point>;
}

let shared: Worker | null = null;
let nextId = 0;

function worker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  shared ??= new Worker(
    new URL("@/workers/layout.worker.ts", import.meta.url),
    { type: "module" }
  );
  return shared;
}

/**
 * Asks the worker; where there is none (a test, a webview without workers)
 * the same function runs here.
 */
function run(request: LayoutRequest): Promise<LayoutAnswer> {
  const live = worker();
  if (!live) {
    return Promise.all([
      import("elkjs/lib/elk.bundled.js"),
      import("@/lib/map-layout"),
    ]).then(([{ default: ELK }, { layOut }]) => layOut(new ELK(), request));
  }
  return new Promise((resolve) => {
    const heard = (event: MessageEvent<LayoutAnswer>) => {
      if (event.data.id !== request.id) return;
      live.removeEventListener("message", heard);
      live.removeEventListener("error", broke);
      resolve(event.data);
    };
    const broke = (event: ErrorEvent) => {
      live.removeEventListener("message", heard);
      live.removeEventListener("error", broke);
      if (shared === live) shared = null;
      live.terminate?.();
      resolve({ id: request.id, groups: [], ms: 0, failed: event.message });
    };
    live.addEventListener("message", heard);
    live.addEventListener("error", broke);
    live.postMessage(request);
  });
}

interface Ask {
  request: LayoutRequest;
  /** The signature of every group laid out by this request. */
  signatures: Map<string, string>;
}

/** The groups in the order they are packed: the handed ones, then the nodes in none. */
function members(
  groups: readonly GraphGroup[],
  nodes: readonly GraphNode[]
): { id: string; collapsed: boolean; nodes: GraphNode[] }[] {
  const by = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const key = node.group ?? OUTSIDE;
    const list = by.get(key);
    if (list) list.push(node);
    else by.set(key, [node]);
  }
  const ordered = groups.map((group) => ({
    id: group.id,
    collapsed: group.collapsed,
    nodes: group.collapsed ? [] : (by.get(group.id) ?? []),
  }));
  const outside = by.get(OUTSIDE);
  if (outside) ordered.push({ id: OUTSIDE, collapsed: false, nodes: outside });
  return ordered;
}

function inModelOrder(nodes: GraphNode[]): GraphNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort(
      (a, b) => (a.node.rank ?? 0) - (b.node.rank ?? 0) || a.index - b.index
    )
    .map(({ node }) => node);
}

/**
 * What to ask the worker, or `null` where nothing that decides a place has
 * changed: a tone, a count, a label never moves anything.
 */
export function askFor(
  groups: readonly GraphGroup[],
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  cache: ReadonlyMap<string, Laid>,
  lastPacked: string | null
): Ask | null {
  const groupOf = new Map(
    nodes.map((node) => [node.id, node.group ?? OUTSIDE])
  );
  const asks: LayoutGroupAsk[] = [];
  const signatures = new Map<string, string>();
  let changed = false;
  for (const group of members(groups, nodes)) {
    if (group.collapsed) {
      asks.push({ id: group.id, size: { width: CARD_W, height: CARD_H } });
      continue;
    }
    if (group.nodes.length === 0) {
      asks.push({ id: group.id, size: { width: CARD_W, height: 72 } });
      continue;
    }
    const ordered = inModelOrder(group.nodes);
    const inside = new Set(ordered.map((node) => node.id));
    const shaping = edges
      .filter(
        (edge) =>
          edge.shapesLayout !== false &&
          inside.has(edge.from) &&
          inside.has(edge.to) &&
          groupOf.get(edge.from) === group.id
      )
      .map((edge) =>
        edge.reversed
          ? { id: edge.id, from: edge.to, to: edge.from }
          : { id: edge.id, from: edge.from, to: edge.to }
      );
    const signature = JSON.stringify([
      ordered.map((node) => node.id),
      shaping.map((edge) => `${edge.from}>${edge.to}`).sort(),
    ]);
    const held = cache.get(group.id);
    if (held?.signature === signature) {
      asks.push({
        id: group.id,
        size: { width: held.width, height: held.height },
      });
      continue;
    }
    changed = true;
    signatures.set(group.id, signature);
    asks.push({
      id: group.id,
      nodes: ordered.map((node) => ({
        id: node.id,
        width: NODE_W,
        height: NODE_H,
      })),
      edges: shaping,
      previous: held?.positions,
    });
  }
  const packed = JSON.stringify(
    asks.map((ask) => [ask.id, ask.size?.width, ask.size?.height])
  );
  if (!changed && packed === lastPacked) return null;
  return { request: { id: ++nextId, groups: asks }, signatures };
}

const NONE: Omit<Placement, "settled"> = {
  groups: new Map(),
  nodes: new Map(),
  failed: null,
};

/**
 * Where every group and node of a canvas sits, worked out in a worker. Only
 * a group whose structure changed is laid out again; the rest are packed by
 * the size they have, so a node that changed keeps its place.
 */
export function useLayout(
  groups: readonly GraphGroup[],
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): Placement {
  const [held] = useState(() => ({
    cache: new Map<string, Laid>(),
    packed: new Map<"last", string>(),
  }));
  const ask = useMemo(
    () =>
      askFor(groups, nodes, edges, held.cache, held.packed.get("last") ?? null),
    [groups, nodes, edges, held]
  );
  const [laid, setLaid] = useState<{
    placement: Omit<Placement, "settled">;
    answers: Ask | null;
  }>({ placement: NONE, answers: null });

  useEffect(() => {
    if (!ask) return;
    let live = true;
    const started = performance.now();
    void run(ask.request).then((answer) => {
      if (!live) return;
      if (answer.failed !== undefined) {
        const failed = answer.failed;
        setLaid((was) => ({
          placement: { ...was.placement, failed },
          answers: ask,
        }));
        return;
      }
      const boxes = new Map<string, Box>();
      const at = new Map<string, Point>();
      for (const group of answer.groups) {
        boxes.set(group.id, group);
        const signature = ask.signatures.get(group.id);
        if (group.positions && signature !== undefined)
          held.cache.set(group.id, {
            signature,
            width: group.width,
            height: group.height,
            positions: group.positions,
          });
        const positions =
          group.positions ?? held.cache.get(group.id)?.positions ?? {};
        for (const [id, point] of Object.entries(positions)) at.set(id, point);
      }
      held.packed.set(
        "last",
        JSON.stringify(
          ask.request.groups.map((group) => {
            const box = boxes.get(group.id);
            return [group.id, box?.width, box?.height];
          })
        )
      );
      setLaid({
        placement: { groups: boxes, nodes: at, failed: null },
        answers: ask,
      });
      if (perf.recording) {
        const end = performance.now();
        perf.record({
          kind: "ipc",
          name: "topologyLayout (worker)",
          ms: answer.ms,
          at: end,
          rows: ask.request.groups.reduce(
            (sum, group) => sum + (group.nodes?.length ?? 0),
            0
          ),
        });
        perf.record({
          kind: "ipc",
          name: "topologyLayout (round trip)",
          ms: end - started,
          at: end,
        });
      }
    });
    return () => {
      live = false;
    };
  }, [ask, held]);

  return useMemo(
    () => ({
      ...laid.placement,
      settled: ask === null || laid.answers === ask,
    }),
    [laid, ask]
  );
}
