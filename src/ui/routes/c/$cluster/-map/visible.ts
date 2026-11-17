import type { Point } from "@/lib/map-layout";
import type { GraphEdge, GraphGroup, GraphNode, MapTone } from "./types";

/**
 * A routed edge as an SVG path through its points, and the point halfway
 * along it, where its words go.
 */
export function routePath(points: readonly Point[]): {
  path: string;
  middle: Point;
} {
  const path = points
    .map(({ x, y }, at) => `${at === 0 ? "M" : "L"} ${x} ${y}`)
    .join(" ");
  const lengths = points
    .slice(1)
    .map((point, at) =>
      Math.hypot(point.x - points[at].x, point.y - points[at].y)
    );
  let left = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (const [at, length] of lengths.entries()) {
    if (left <= length) {
      const share = length === 0 ? 0 : left / length;
      return {
        path,
        middle: {
          x: points[at].x + (points[at + 1].x - points[at].x) * share,
          y: points[at].y + (points[at + 1].y - points[at].y) * share,
        },
      };
    }
    left -= length;
  }
  return { path, middle: points[0] ?? { x: 0, y: 0 } };
}

/**
 * The ends an edge is drawn between, left to right: a reversed one from its
 * `to`, so a Gateway's line leaves its right side for its route's left, as
 * the layout put them, instead of running back across both.
 */
export const drawnEnds = (edge: GraphEdge) =>
  edge.reversed
    ? { source: edge.to, target: edge.from }
    : { source: edge.from, target: edge.to };

/** The id a collapsed group's card is drawn under. */
export const cardId = (group: string) => `group:${group}`;

/** Which of two tones an edge folded from both keeps: the louder. */
const LOUDNESS: Record<MapTone, number> = {
  err: 4,
  warn: 3,
  unknown: 2,
  ok: 1,
  mute: 0,
};

export interface Visible {
  /** The nodes drawn: those in an expanded group, and those in none. */
  nodes: GraphNode[];
  /** Every edge, an end in a collapsed group moved to its card, one per pair. */
  edges: GraphEdge[];
}

/**
 * What a canvas draws of a graph with some groups collapsed: their nodes
 * folded into their cards, and every edge into or out of one drawn to the
 * card instead, once per pair, at the loudest tone and widest weight it
 * carried. An edge inside a collapsed group is not drawn at all.
 */
export function visibleGraph(
  groups: readonly GraphGroup[],
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[]
): Visible {
  const collapsed = new Set(
    groups.filter((group) => group.collapsed).map((group) => group.id)
  );
  const known = new Set(groups.map((group) => group.id));
  const at = new Map<string, string>();
  const drawn: GraphNode[] = [];
  for (const node of nodes) {
    if (node.group !== null && !known.has(node.group)) continue;
    if (node.group !== null && collapsed.has(node.group)) {
      at.set(node.id, cardId(node.group));
    } else {
      at.set(node.id, node.id);
      drawn.push(node);
    }
  }
  const folded = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const from = at.get(edge.from);
    const to = at.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    if (from === edge.from && to === edge.to) {
      folded.set(edge.id, edge);
      continue;
    }
    const id = `${from}>${to}`;
    const held = folded.get(id);
    folded.set(
      id,
      held
        ? {
            ...held,
            tone:
              LOUDNESS[edge.tone] > LOUDNESS[held.tone] ? edge.tone : held.tone,
            weight: Math.max(held.weight ?? 0, edge.weight ?? 0) || undefined,
            flow: held.flow === "forward" ? "forward" : edge.flow,
            label: undefined,
            sub: undefined,
          }
        : { ...edge, id, from, to, shapesLayout: false }
    );
  }
  return { nodes: drawn, edges: [...folded.values()] };
}
