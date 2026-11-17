/**
 * Where everything on a map sits, by ELK: each group laid out on its own,
 * left to right, then the groups packed in the order they were handed.
 *
 * A group whose structure did not change is not laid out again; it is only
 * packed, by the size it already has. A node in a group that did change is
 * handed the place it had, so ELK keeps the order of what stayed
 * (https://eclipse.dev/elk/reference/options/org-eclipse-elk-layered-crossingMinimization-semiInteractive.html).
 *
 * Groups an edge joins are laid out together, as one layered graph with the
 * groups as its compound nodes: a caller's group stands before its callee's,
 * and every edge among them is routed around the nodes rather than drawn
 * straight through whatever stands between. Groups no edge joins are packed
 * after them, each from its own cached layout.
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

/** An edge between two groups, pointing the way it lays out. */
export interface LayoutLink {
  id: string;
  /** A node, or a collapsed group's own id. */
  from: string;
  to: string;
  fromGroup: string;
  toGroup: string;
}

export interface LayoutRequest {
  id: number;
  groups: LayoutGroupAsk[];
  /** Edges between groups; every group they touch is handed whole. */
  links?: LayoutLink[];
}

export interface LayoutGroupAnswer {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Relative to the group, where it was laid out. */
  positions?: Record<string, Point>;
  /** Each edge laid out inside the group, as points relative to it. */
  routes?: Record<string, Point[]>;
}

export interface LayoutAnswer {
  id: number;
  groups: LayoutGroupAnswer[];
  /** Each edge among groups laid out together, as points on the map. */
  routes?: Record<string, Point[]>;
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
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.padding": `[top=${GROUP_HEADER},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]`,
};

/** The groups an edge joins, laid out as one: groups left to right, edges around nodes. */
const JOINED_OPTIONS: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.spacing.nodeNode": "28",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "org.eclipse.elk.json.edgeCoords": "ROOT",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

/** Space between the joined groups and the packed ones under them. */
const BLOCK_GAP = 40;

type ElkEdgeOut = NonNullable<ElkNode["edges"]>[number] & {
  sections?: {
    startPoint: Point;
    endPoint: Point;
    bendPoints?: Point[];
  }[];
};

/** Each laid edge as its points, start to end. */
function routesOf(edges: readonly ElkEdgeOut[] | undefined) {
  const routes: Record<string, Point[]> = {};
  for (const edge of edges ?? []) {
    const section = edge.sections?.[0];
    if (section)
      routes[edge.id] = [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ].map(({ x, y }) => ({ x, y }));
  }
  return routes;
}

const elkEdges = (edges: readonly { id: string; from: string; to: string }[]) =>
  edges.map((edge) => ({
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
  }));

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
  routes: Record<string, Point[]>;
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
    routes: routesOf(result.edges as ElkEdgeOut[] | undefined),
  };
}

/** The groups the links join, laid out as one graph. */
async function layOutJoined(
  elk: ElkLike,
  groups: readonly LayoutGroupAsk[],
  links: readonly LayoutLink[]
): Promise<{
  groups: LayoutGroupAnswer[];
  routes: Record<string, Point[]>;
  width: number;
  height: number;
}> {
  const result = await elk.layout({
    id: "joined",
    layoutOptions: JOINED_OPTIONS,
    children: groups.map((group) =>
      group.nodes && group.nodes.length > 0
        ? {
            id: group.id,
            // The root's options lay the whole hierarchy out; a group's own
            // model-order strategy inside it makes ELK throw.
            layoutOptions: { "elk.padding": GROUP_OPTIONS["elk.padding"] },
            children: group.nodes.map((node) => ({
              id: node.id,
              width: node.width,
              height: node.height,
            })),
            edges: elkEdges(group.edges ?? []),
          }
        : {
            id: group.id,
            width: group.size?.width ?? 0,
            height: group.size?.height ?? 0,
          }
    ),
    edges: elkEdges(links),
  });
  const routes = routesOf(result.edges as ElkEdgeOut[] | undefined);
  const laid: LayoutGroupAnswer[] = [];
  for (const child of result.children ?? []) {
    Object.assign(routes, routesOf(child.edges as ElkEdgeOut[] | undefined));
    const positions: Record<string, Point> = {};
    for (const node of child.children ?? [])
      positions[node.id] = { x: node.x ?? 0, y: node.y ?? 0 };
    laid.push({
      id: child.id,
      x: child.x ?? 0,
      y: child.y ?? 0,
      width: child.width ?? 0,
      height: child.height ?? 0,
      ...(child.children ? { positions } : {}),
    });
  }
  return {
    groups: laid,
    routes,
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}

/** Lays out what changed and packs every group, in the order handed. */
export async function layOut(
  elk: ElkLike,
  request: LayoutRequest
): Promise<LayoutAnswer> {
  const started = performance.now();
  const links = request.links ?? [];
  const joinedIds = new Set(
    links.flatMap((link) => [link.fromGroup, link.toGroup])
  );
  const joined =
    joinedIds.size > 0
      ? await layOutJoined(
          elk,
          request.groups.filter((group) => joinedIds.has(group.id)),
          links
        )
      : null;
  const sized: LayoutGroupAnswer[] = [];
  for (const group of request.groups) {
    if (joinedIds.has(group.id)) continue;
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
  const below = joined ? joined.height + BLOCK_GAP : 0;
  const at = new Map(
    (packed.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: (child.y ?? 0) + below },
    ])
  );
  return {
    id: request.id,
    groups: [
      ...(joined?.groups ?? []),
      ...sized.map((group) => ({ ...group, ...at.get(group.id) })),
    ],
    ...(joined ? { routes: joined.routes } : {}),
    ms: performance.now() - started,
  };
}
