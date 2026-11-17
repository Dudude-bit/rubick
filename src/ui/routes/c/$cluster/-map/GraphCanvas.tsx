/**
 * A map of objects in groups: the canvas Topology draws the cluster on and
 * Traffic draws its flows on.
 *
 * ```
 * <GraphCanvas groups nodes edges onToggleGroup onOpen onOpenEdge? highlight? focus? fitKey? ariaLabel ref />
 *
 * GraphNode  { id, group: string | null, kind, crd?, label, sub?, tone: MapTone,
 *              badge?: { text, tone }, rank? }
 * GraphEdge  { id, from, to, tone: MapTone, weight?: 0–1 (1–4 px), flow?: "forward" | "none",
 *              label?, sub?, shapesLayout? (true), reversed? }
 * GraphGroup { id, label, collapsed, tone: MapTone, summary: ReactNode, refused? }
 * ref        { fit(), centre(id), toSvg() }
 * MapTone    "ok" | "warn" | "err" | "mute" | "unknown"; unknown is the dashed not-checked ring
 * ```
 *
 * - A node with `group: null` is drawn outside every group: an address
 *   outside the cluster.
 * - A collapsed group is a card: its nodes are folded into it and every edge
 *   into or out of one is drawn to the card, once per pair at its loudest
 *   tone (`visibleGraph`).
 * - Node ids for cluster objects come from `nodeId()` in `./ids`, the
 *   backend's own spelling.
 * - `flow: "forward"` moves dashes along the edge; still under reduced
 *   motion and while the canvas is off screen.
 * - `onOpenEdge` makes every edge a button the keyboard reaches; without it
 *   an edge shows its `label` and `sub` while either end is singled out.
 * - The view is fitted once to the first layout laid out whole, and again
 *   to the first after `fitKey` changes; `null` holds the fit back. A later
 *   change moves nothing under the reader.
 * - Places are worked out in a worker. Only a group whose nodes or shaping
 *   edges changed is laid out again, so a tone or a label never moves
 *   anything, and a node added keeps the others in their order.
 */

import "@xyflow/react/dist/base.css";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStoreApi,
  type Edge,
  type Node,
} from "@xyflow/react";

import { useT } from "@/i18n/useT";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import {
  LightContext,
  MapContext,
  type MapActions,
  type MapLight,
} from "./map-context";
import { GroupCard, GroupFrame, MapEdge, ObjectNode } from "./map-parts";
import { mapSvg, themeColours } from "./svg";
import type {
  GraphCanvasHandle,
  GraphEdge,
  GraphGroup,
  GraphNode,
} from "./types";
import { NODE_H, NODE_W, OUTSIDE, useLayout } from "./useLayout";
import { cardId, drawnEnds, visibleGraph } from "./visible";

export type { GraphCanvasHandle, GraphEdge, GraphGroup, GraphNode };

const NODE_TYPES = { object: ObjectNode, frame: GroupFrame, card: GroupCard };
const EDGE_TYPES = { map: MapEdge };

const FIT = { padding: 0.08 };

/**
 * Nothing on the map is selectable or draggable, and React Flow then writes
 * `pointer-events: none` on every node's wrapper: no click, no double click,
 * no hover, no fold. A node's own style is spread after it, so this wins.
 */
const TAKES_POINTER = { pointerEvents: "all" } as const;

/** Past this many drawn nodes only those in view are mounted. */
export const MOUNT_ALL_UP_TO = 600;

export interface GraphCanvasProps {
  groups: readonly GraphGroup[];
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  onToggleGroup: (id: string) => void;
  onOpen: (node: GraphNode, how: "peek" | "page") => void;
  onOpenEdge?: (edge: GraphEdge) => void;
  /** The nodes a search found; the rest are dimmed. */
  highlight?: ReadonlySet<string> | null;
  /** A node to pan to once it is placed: a search's pick in a group just opened. */
  focus?: string | null;
  /** A new value fits the view to the next layout laid out whole; `null` waits. */
  fitKey?: string | null;
  ariaLabel: string;
  /** Plain words for a collapsed card's summary, for the image. */
  summaryText?: (group: GraphGroup) => string;
  /** What the page says above the map about what it could not read, for the image. */
  caveats?: readonly string[];
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvas(props, ref) {
    return (
      <ReactFlowProvider>
        <Canvas {...props} handle={ref} />
      </ReactFlowProvider>
    );
  }
);

function Canvas({
  groups,
  nodes,
  edges,
  onToggleGroup,
  onOpen,
  onOpenEdge,
  highlight,
  focus,
  fitKey = "",
  ariaLabel,
  summaryText,
  caveats,
  handle,
}: GraphCanvasProps & { handle: React.ForwardedRef<GraphCanvasHandle> }) {
  const t = useT();
  const flow = useReactFlow();
  const store = useStoreApi();
  const visible = useSurfaceVisible();
  const drawn = useMemo(
    () => visibleGraph(groups, nodes, edges),
    [groups, nodes, edges]
  );
  const placement = useLayout(groups, drawn.nodes, drawn.edges);
  const [active, setActive] = useState<string | null>(null);
  // What React Flow is handed for each node, group and edge lives as long as
  // the object handed in does and stays where it was: React Flow compares by
  // identity, and a new object for each of them on every render redrew the
  // whole map for one batch or one answer.
  const [held] = useState(() => ({
    nodes: new WeakMap<GraphNode, Node>(),
    groups: new WeakMap<GraphGroup, Node>(),
    edges: new WeakMap<GraphEdge, Edge>(),
  }));

  const neighbours = useMemo(() => {
    if (active === null) return null;
    const lit = new Set([active]);
    for (const edge of drawn.edges) {
      if (edge.from === active) lit.add(edge.to);
      if (edge.to === active) lit.add(edge.from);
    }
    return lit;
  }, [active, drawn.edges]);

  const absolute = useCallback(
    (node: GraphNode) => {
      const box = placement.groups.get(node.group ?? OUTSIDE);
      const at = placement.nodes.get(node.id);
      return box && at ? { x: box.x + at.x, y: box.y + at.y } : null;
    },
    [placement]
  );

  const centre = useCallback(
    (id: string) => {
      const node = drawn.nodes.find((each) => each.id === id);
      const at = node && absolute(node);
      if (at) {
        void flow.setCenter(at.x + NODE_W / 2, at.y + NODE_H / 2, {
          zoom: Math.max(flow.getZoom(), 1),
          duration: 200,
        });
        return;
      }
      const group = nodes.find((each) => each.id === id)?.group;
      const box = group ? placement.groups.get(group) : undefined;
      if (box)
        void flow.setCenter(box.x + box.width / 2, box.y + box.height / 2, {
          zoom: Math.max(flow.getZoom(), 1),
          duration: 200,
        });
    },
    [drawn.nodes, nodes, absolute, placement, flow]
  );

  const centred = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || centred.current === focus) return;
    if (!placement.nodes.has(focus)) return;
    centred.current = focus;
    centre(focus);
  }, [focus, placement, centre]);

  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (fitKey === null || fitted.current === fitKey) return;
    if (!placement.settled || placement.groups.size === 0) return;
    fitted.current = fitKey;
    void flow.fitView(FIT);
  }, [fitKey, placement, flow]);

  const reveal = useCallback(
    (id: string) => {
      const node = drawn.nodes.find((each) => each.id === id);
      const at = node && absolute(node);
      if (!at) return;
      const { x, y, zoom } = flow.getViewport();
      const { width, height } = store.getState();
      const left = at.x * zoom + x;
      const top = at.y * zoom + y;
      if (
        left < 0 ||
        top < 0 ||
        left + NODE_W * zoom > width ||
        top + NODE_H * zoom > height
      )
        centre(id);
    },
    [drawn.nodes, absolute, flow, store, centre]
  );

  // Read through a ref from the handlers alone, so the actions stay one
  // object while the data under them changes.
  const latest = useRef({ onOpen, onOpenEdge, onToggleGroup, reveal });
  useEffect(() => {
    latest.current = { onOpen, onOpenEdge, onToggleGroup, reveal };
  });
  const edgesOpen = onOpenEdge !== undefined;
  const actions = useMemo<MapActions>(
    () => ({
      open: (node, how) => latest.current.onOpen(node, how),
      openEdge: edgesOpen
        ? (edge) => latest.current.onOpenEdge?.(edge)
        : undefined,
      toggle: (id) => latest.current.onToggleGroup(id),
      setActive,
      reveal: (id) => latest.current.reveal(id),
    }),
    [edgesOpen]
  );
  const light = useMemo<MapLight>(
    () => ({
      lit: (id) => {
        if (neighbours) return neighbours.has(id);
        if (highlight) return highlight.has(id);
        return null;
      },
      touched: (edge) =>
        active !== null && (edge.from === active || edge.to === active),
    }),
    [neighbours, highlight, active]
  );

  const flowNodes = useMemo(() => {
    const out: Node[] = [];
    for (const group of groups) {
      const box = placement.groups.get(group.id);
      if (!box) continue;
      const was = held.groups.get(group);
      if (
        was &&
        was.position.x === box.x &&
        was.position.y === box.y &&
        was.width === box.width &&
        was.height === box.height
      ) {
        out.push(was);
        continue;
      }
      const flow: Node = {
        id: cardId(group.id),
        type: group.collapsed ? "card" : "frame",
        position: { x: box.x, y: box.y },
        data: { group },
        width: box.width,
        height: box.height,
        style: { ...TAKES_POINTER, width: box.width, height: box.height },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: 0,
      };
      held.groups.set(group, flow);
      out.push(flow);
    }
    for (const node of drawn.nodes) {
      const at = placement.nodes.get(node.id);
      const box = placement.groups.get(node.group ?? OUTSIDE);
      if (!at || !box) continue;
      const position =
        node.group === null ? { x: box.x + at.x, y: box.y + at.y } : at;
      const was = held.nodes.get(node);
      if (
        was &&
        was.position.x === position.x &&
        was.position.y === position.y
      ) {
        out.push(was);
        continue;
      }
      const flow: Node = {
        id: node.id,
        type: "object",
        position,
        parentId: node.group === null ? undefined : cardId(node.group),
        data: was?.data ?? { node },
        style: TAKES_POINTER,
        width: NODE_W,
        height: NODE_H,
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: 1,
      };
      held.nodes.set(node, flow);
      out.push(flow);
    }
    return out;
  }, [groups, drawn.nodes, placement, held]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      drawn.edges.map((edge) => {
        const route = placement.routes.get(edge.id);
        const was = held.edges.get(edge);
        if (was && was.data?.route === route) return was;
        const flow: Edge = {
          id: edge.id,
          ...drawnEnds(edge),
          type: "map",
          data: { edge, route },
          selectable: false,
          focusable: false,
          zIndex: 2,
        };
        held.edges.set(edge, flow);
        return flow;
      }),
    [drawn.edges, held, placement.routes]
  );

  useImperativeHandle(
    handle,
    () => ({
      fit: () => void flow.fitView({ ...FIT, duration: 200 }),
      centre,
      toSvg: () =>
        mapSvg({
          colours: themeColours(),
          notes: caveats,
          groups: groups.flatMap((group) => {
            const box = placement.groups.get(group.id);
            return box
              ? [{ group, box, summary: summaryText?.(group) ?? "" }]
              : [];
          }),
          nodes: drawn.nodes.flatMap((node) => {
            const at = absolute(node);
            return at ? [{ node, at, width: NODE_W, height: NODE_H }] : [];
          }),
          edges: drawn.edges.flatMap((edge) => {
            const end = (id: string, side: "from" | "to") => {
              const node = drawn.nodes.find((each) => each.id === id);
              const at = node && absolute(node);
              if (at)
                return {
                  x: side === "from" ? at.x + NODE_W : at.x,
                  y: at.y + NODE_H / 2,
                };
              const box = placement.groups.get(id.replace(/^group:/, ""));
              return box
                ? {
                    x: side === "from" ? box.x + box.width : box.x,
                    y: box.y + box.height / 2,
                  }
                : null;
            };
            const { source, target } = drawnEnds(edge);
            const from = end(source, "from");
            const to = end(target, "to");
            return from && to
              ? [{ edge, from, to, route: placement.routes.get(edge.id) }]
              : [];
          }),
        }),
    }),
    [flow, centre, groups, placement, drawn, absolute, summaryText, caveats]
  );

  return (
    <MapContext.Provider value={actions}>
      <LightContext.Provider value={light}>
        <div
          className="map-canvas relative h-full w-full"
          role="group"
          aria-label={ariaLabel}
          data-paused={visible ? undefined : ""}
        >
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            onlyRenderVisibleElements={drawn.nodes.length > MOUNT_ALL_UP_TO}
            minZoom={0.05}
            maxZoom={2}
            ariaLabelConfig={{
              "node.a11yDescription.default": t("topology", "nodeKeys"),
              "node.a11yDescription.keyboardDisabled": t(
                "topology",
                "nodeKeys"
              ),
            }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1}
              color="hsl(var(--hair))"
            />
          </ReactFlow>
          {placement.failed !== null && (
            <p
              role="alert"
              className="absolute right-3 bottom-3 left-3 rounded-md bg-raise/90 px-2 py-1 text-[11.5px] text-err"
            >
              {t("topology", "layoutFailed", { said: placement.failed })}
            </p>
          )}
        </div>
      </LightContext.Provider>
    </MapContext.Provider>
  );
}
