/**
 * Where everything on a map sits, by ELK: each group laid out on its own,
 * left to right, then the groups packed in the order they were handed.
 *
 * A group whose structure did not change is not laid out again; it is only
 * packed, by the size it already has. A node in a group that did change is
 * handed the place it had, so ELK keeps the order of what stayed
 * (https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-crossingMinimization-semiInteractive.html).
 */

import type { ElkNode, LayoutOptions } from "elkjs/lib/elk-api";

export interface Point {
  x: number;
  y: number;
}

export interface LayoutGroupAsk {
  id: string;
  /** Present where the group is to be laid out: its nodes in model order. */
  nodes?: { id: string; width: number; height: number }[];
  /** Edges inside the group, already pointing the way they lay out. */
  edges?: { id: string; from: string; to: string }[];
  /** Where each node sat in the group's last layout. */
  previous?: Record<string, Point>;
  /** A group held as it is, or a card: only packed, at this size. */
  size?: { width: number; height: number };
}

export interface LayoutRequest {
  id: number;
  groups: LayoutGroupAsk[];
}

export interface LayoutGroupAnswer {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Relative to the group, where it was laid out. */
  positions?: Record<string, Point>;
}

export interface LayoutAnswer {
  id: number;
  groups: LayoutGroupAnswer[];
  /** How long the layout took in the worker. */
  ms: number;
  /** Why there is no answer, where none could be computed. */
  failed?: string;
}

/** What `elkjs` offers, so a test can hand in the bundled build directly. */
export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

/** Room above a group's nodes for its title. */
export const GROUP_HEADER = 40;
export const GROUP_PAD = 16;

const GROUP_OPTIONS: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.spacing.nodeNode": "14",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.padding": `[top=${GROUP_HEADER},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]`,
};

const PACK_OPTIONS: LayoutOptions = {
  "elk.algorithm": "rectpacking",
  "elk.spacing.nodeNode": "28",
  "elk.aspectRatio": "1.6",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

async function layOutGroup(
  elk: ElkLike,
  group: LayoutGroupAsk
): Promise<{
  width: number;
  height: number;
  positions: Record<string, Point>;
}> {
  const nodes = group.nodes ?? [];
  const inside = new Set(nodes.map((node) => node.id));
  const previous = group.previous ?? {};
  const placed = nodes.some((node) => previous[node.id]);
  const result = await elk.layout({
    id: group.id,
    layoutOptions: placed
      ? {
          ...GROUP_OPTIONS,
          "elk.layered.crossingMinimization.semiInteractive": "true",
        }
      : GROUP_OPTIONS,
    children: nodes.map((node) => {
      const was = previous[node.id];
      const layoutOptions: LayoutOptions = was
        ? { "elk.position": `(${was.x}, ${was.y})` }
        : {};
      return {
        id: node.id,
        width: node.width,
        height: node.height,
        layoutOptions,
      };
    }),
    edges: (group.edges ?? [])
      .filter(
        (edge) =>
          edge.from !== edge.to && inside.has(edge.from) && inside.has(edge.to)
      )
      .map((edge) => ({
        id: edge.id,
        sources: [edge.from],
        targets: [edge.to],
      })),
  });
  const positions: Record<string, Point> = {};
  for (const child of result.children ?? [])
    positions[child.id] = { x: child.x ?? 0, y: child.y ?? 0 };
  return {
    width: result.width ?? GROUP_PAD * 2,
    height: result.height ?? GROUP_HEADER + GROUP_PAD,
    positions,
  };
}

/** Lays out what changed and packs every group, in the order handed. */
export async function layOut(
  elk: ElkLike,
  request: LayoutRequest
): Promise<LayoutAnswer> {
  const started = performance.now();
  const sized: LayoutGroupAnswer[] = [];
  for (const group of request.groups) {
    if (group.nodes) {
      const laid = await layOutGroup(elk, group);
      sized.push({ id: group.id, x: 0, y: 0, ...laid });
    } else {
      const size = group.size ?? { width: 0, height: 0 };
      sized.push({ id: group.id, x: 0, y: 0, ...size });
    }
  }
  const packed = await elk.layout({
    id: "map",
    layoutOptions: PACK_OPTIONS,
    children: sized.map((group) => ({
      id: group.id,
      width: group.width,
      height: group.height,
    })),
  });
  const at = new Map(
    (packed.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0 },
    ])
  );
  return {
    id: request.id,
    groups: sized.map((group) => ({ ...group, ...at.get(group.id) })),
    ms: performance.now() - started,
  };
}
