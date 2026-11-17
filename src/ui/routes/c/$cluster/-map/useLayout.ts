import { useEffect, useMemo, useRef, useState } from "react";

import type {
  LayoutAnswer,
  LayoutGroupAsk,
  LayoutLink,
  LayoutRequest,
  Point,
} from "@/lib/map-layout";
import { errorToShow } from "@/lib/error-utils";
import { perf } from "@/lib/perf";
import type { GraphEdge, GraphGroup, GraphNode } from "./types";
import { cardId } from "./visible";

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
  /** Each edge the layout routed, as points on the map: around nodes, never through one. */
  routes: ReadonlyMap<string, Point[]>;
}

interface Laid {
  signature: string;
  width: number;
  height: number;
  positions: Record<string, Point>;
  /** Relative to the group; only for a group laid out on its own. */
  routes?: Record<string, Point[]>;
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
  /** The groups whose last layout still holds their nodes as they are. */
  kept: Set<string>;
}

/** How the groups were packed, and by which edges between them. */
export const packingKey = (
  sizes: readonly (readonly [string, number?, number?])[],
  links: readonly LayoutLink[]
) =>
  JSON.stringify([
    sizes,
    links.map((link) => `${link.from}>${link.to}`).sort(),
  ]);

const CARD = cardId("");

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
  // An edge between two groups joins them: they are laid out together, the
  // caller's before the callee's. A collapsed group's card stands for it.
  const placeOf = (id: string) =>
    id.startsWith(CARD)
      ? { group: id.slice(CARD.length), at: id.slice(CARD.length) }
      : { group: groupOf.get(id), at: id };
  const links: LayoutLink[] = [];
  for (const edge of edges) {
    const [from, to] = edge.reversed
      ? [placeOf(edge.to), placeOf(edge.from)]
      : [placeOf(edge.from), placeOf(edge.to)];
    if (!from.group || !to.group || from.group === to.group) continue;
    links.push({
      id: edge.id,
      from: from.at,
      to: to.at,
      fromGroup: from.group,
      toGroup: to.group,
    });
  }
  const joined = new Set(
    links.flatMap((link) => [link.fromGroup, link.toGroup])
  );
  const asks: LayoutGroupAsk[] = [];
  const sizes: [string, number?, number?][] = [];
  const signatures = new Map<string, string>();
  const kept = new Set<string>();
  let changed = false;
  for (const group of members(groups, nodes)) {
    if (group.collapsed) {
      asks.push({ id: group.id, size: { width: CARD_W, height: CARD_H } });
      sizes.push([group.id, CARD_W, CARD_H]);
      continue;
    }
    if (group.nodes.length === 0) {
      asks.push({ id: group.id, size: { width: CARD_W, height: 72 } });
      sizes.push([group.id, CARD_W, 72]);
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
    // A group last laid out with others holds no routes of its own; once it
    // stands alone it is laid out again for them.
    if (
      held?.signature === signature &&
      (joined.has(group.id) || held.routes !== undefined)
    ) {
      sizes.push([group.id, held.width, held.height]);
      // A joined group is handed whole whenever anything is asked: the
      // groups it is laid out with may have moved.
      if (!joined.has(group.id)) {
        asks.push({
          id: group.id,
          size: { width: held.width, height: held.height },
        });
        kept.add(group.id);
        continue;
      }
    } else {
      changed = true;
      sizes.push([group.id]);
    }
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
  if (!changed && packingKey(sizes, links) === lastPacked) return null;
  return {
    request: { id: ++nextId, groups: asks, links },
    signatures,
    kept,
  };
}

const NONE: Omit<Placement, "settled"> = {
  groups: new Map(),
  nodes: new Map(),
  failed: null,
  routes: new Map(),
};

/**
 * Where every group and node of a canvas sits, worked out in a worker. Only
 * a group whose structure changed is laid out again; the rest are packed by
 * the size they have, so a node that changed keeps its place.
 *
 * One request is in flight at a time and every answer is kept: what changed
 * while it ran is asked once it is back. Dropping the answer in flight on
 * each render asked for the same layout again behind it, so on a scope that
 * takes longer to lay out than it takes to change, nothing was ever placed.
 */
export function useLayout(
  groups: readonly GraphGroup[],
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): Placement {
  const [laid, setLaid] = useState<{
    placement: Omit<Placement, "settled">;
    /** Every group laid out so far, by the structure it was laid out for. */
    cache: ReadonlyMap<string, Laid>;
    /** How the last answer packed the groups. */
    packed: string | null;
    /** The request that failed, not asked again until the canvas changes. */
    failedAsk: string | null;
  }>({ placement: NONE, cache: new Map(), packed: null, failedAsk: null });
  const ask = useMemo(() => {
    const next = askFor(groups, nodes, edges, laid.cache, laid.packed);
    return next && JSON.stringify(next.request.groups) === laid.failedAsk
      ? null
      : next;
  }, [groups, nodes, edges, laid.cache, laid.packed, laid.failedAsk]);
  const flying = useRef(false);

  useEffect(() => {
    if (!ask || flying.current) return;
    flying.current = true;
    const started = performance.now();
    void run(ask.request)
      .catch((error: unknown): LayoutAnswer => ({
        id: ask.request.id,
        groups: [],
        ms: 0,
        failed: errorToShow(error),
      }))
      .then((answer) => {
        flying.current = false;
        if (answer.failed !== undefined) {
          const failed = answer.failed;
          setLaid((was) => ({
            ...was,
            placement: { ...was.placement, failed },
            failedAsk: JSON.stringify(ask.request.groups),
          }));
          return;
        }
        setLaid((was) => {
          const cache = new Map(was.cache);
          const boxes = new Map<string, Box>();
          const at = new Map<string, Point>();
          const routes = new Map(Object.entries(answer.routes ?? {}));
          const joined = new Set(
            (ask.request.links ?? []).flatMap((link) => [
              link.fromGroup,
              link.toGroup,
            ])
          );
          for (const group of answer.groups) {
            boxes.set(group.id, group);
            const signature = ask.signatures.get(group.id);
            if (group.positions && signature !== undefined)
              cache.set(group.id, {
                signature,
                width: group.width,
                height: group.height,
                positions: group.positions,
                routes: group.routes,
              });
            // A collapsed or emptied group's last layout holds nodes that
            // may since have moved to another group.
            const held =
              group.positions || ask.kept.has(group.id)
                ? cache.get(group.id)
                : undefined;
            const positions = group.positions ?? held?.positions ?? {};
            for (const [id, point] of Object.entries(positions))
              at.set(id, point);
            // A group laid out on its own routes its edges in its own frame;
            // the joined ones came routed on the map.
            if (!joined.has(group.id))
              for (const [id, points] of Object.entries(held?.routes ?? {}))
                routes.set(
                  id,
                  points.map((point) => ({
                    x: point.x + group.x,
                    y: point.y + group.y,
                  }))
                );
          }
          return {
            placement: { groups: boxes, nodes: at, failed: null, routes },
            failedAsk: null,
            cache,
            packed: packingKey(
              ask.request.groups.map((group) => {
                const box = boxes.get(group.id);
                return [group.id, box?.width, box?.height] as const;
              }),
              ask.request.links ?? []
            ),
          };
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
  }, [ask]);

  return useMemo(
    () => ({ ...laid.placement, settled: ask === null }),
    [laid.placement, ask]
  );
}
