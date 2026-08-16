/**
 * The routing layer drawn as what it is: a fan-out, left to right.
 *
 * ## Why this is a graph and the chain is not
 *
 * A single request's journey is a **chain** — entry point, rule, middleware,
 * service, pods, in that order and never any other — and `page-kit`'s
 * `Column`/`Cell` draw exactly that. This answers a different question. "How
 * is the routing built" is about the *shape across hosts*: which entry points
 * carry which hostnames, which hostnames land on the same Service, and where
 * one broken backend is quietly serving four of them. That shape is invisible
 * in a list of eighty rows no matter how the rows are ordered, and it is the
 * question a page whose whole reason is "this cluster's routing" owes an
 * answer to.
 *
 * ## Not a force-directed blob
 *
 * Layered and deterministic: the columns are fixed and labelled, the middle
 * column keeps the order it was handed — which is trouble-first, the same as
 * every list in this app — and the outer columns are placed at the average
 * height of what they connect to and then pushed apart. Two readers looking
 * at the same cluster see the same picture, and it does not rearrange itself
 * when a pod restarts.
 *
 * ## What it never does
 *
 * Invent an edge. Every line here is one object naming another — an entry
 * point a router is bound to, a backend a rule names — and a host whose
 * backing has not been read yet draws a neutral line rather than a green one.
 * Colour is earned the same way it is everywhere else: red is a path that
 * stops, amber is worth a look, and everything healthy is left alone.
 */

import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { ObjectLink, objectUrl } from "@/components/resources/ResourceRef";
import { cn } from "@/lib/utils";

export type MapTone = "ok" | "warn" | "err" | "mute";

export interface MapNode {
  id: string;
  /** The name, in mono. Truncated with the full string on hover. */
  label: string;
  /** One quieter line under it: an address, a namespace and port, a count. */
  sub?: string;
  tone: MapTone;
  /**
   * The object this node *is*, where it is one. Clicking it opens the peek
   * beside the map rather than replacing the map — which is the whole reason
   * to draw a map: comparing four hosts means opening four backends without
   * losing the shape they share.
   *
   * Takes precedence over {@link to}. A node that is not an object — a host,
   * an entry point — has no reference and keeps a plain destination.
   */
  object?: { kind: string; name: string; namespace?: string | null };
  /** Where clicking it goes, inside this app. Absent draws plain text. */
  to?: string;
  /** A word at the top right of the node — `TLS`, `0 ready`. */
  tag?: { text: string; tone: MapTone };
}

export interface MapEdge {
  from: string;
  to: string;
  tone: MapTone;
}

export interface MapColumn {
  label: string;
  nodes: MapNode[];
}

export interface RoutingMapData {
  columns: MapColumn[];
  edges: MapEdge[];
}

/** Column widths, in the order the columns are handed over. */
const WIDTHS = [156, 216, 208];
const GAP = 60;
const NODE_H = 46;
const NODE_GAP = 10;
const HEADER_H = 20;

const TONE_BORDER: Record<MapTone, string> = {
  ok: "border-hair",
  warn: "border-warn/50",
  err: "border-err/60",
  mute: "border-hair",
};

const TONE_TEXT: Record<MapTone, string> = {
  ok: "text-fg-mid",
  warn: "text-warn",
  err: "text-err",
  mute: "text-fg-fnt",
};

const EDGE_TEXT: Record<MapTone, string> = {
  ok: "text-hair",
  warn: "text-warn/60",
  err: "text-err/70",
  mute: "text-hair",
};

interface Placed {
  node: MapNode;
  column: number;
  x: number;
  y: number;
  width: number;
}

/**
 * Where every node sits.
 *
 * The middle column is the spine and keeps the order it arrived in. Every
 * other column is placed at the mean height of what it connects to and then
 * swept downward so nothing overlaps — which keeps an entry point beside the
 * hosts it actually serves instead of at the top of a list of four.
 */
function place(data: RoutingMapData): { placed: Placed[]; height: number } {
  const spine = Math.min(1, data.columns.length - 1);
  const xOf = (column: number) =>
    data.columns
      .slice(0, column)
      .reduce((sum, _, index) => sum + (WIDTHS[index] ?? 180) + GAP, 0);

  const y = new Map<string, number>();
  data.columns[spine]?.nodes.forEach((node, index) => {
    y.set(node.id, index * (NODE_H + NODE_GAP));
  });

  for (let column = 0; column < data.columns.length; column++) {
    if (column === spine) continue;
    const wanted = data.columns[column].nodes.map((node) => {
      const linked = data.edges
        .filter((edge) => edge.from === node.id || edge.to === node.id)
        .map((edge) => y.get(edge.from === node.id ? edge.to : edge.from))
        .filter((value): value is number => value !== undefined);
      return {
        node,
        at: linked.length
          ? linked.reduce((sum, value) => sum + value, 0) / linked.length
          : 0,
      };
    });
    // Swept in the order they were handed over rather than by height, so a
    // column never silently reorders itself between two renders of the same
    // cluster.
    let floor = 0;
    for (const entry of wanted) {
      const at = Math.max(entry.at, floor);
      y.set(entry.node.id, at);
      floor = at + NODE_H + NODE_GAP;
    }
  }

  const placed = data.columns.flatMap((column, index) =>
    column.nodes.map((node): Placed => ({
      node,
      column: index,
      x: xOf(index),
      y: y.get(node.id) ?? 0,
      width: WIDTHS[index] ?? 180,
    }))
  );

  return {
    placed,
    height:
      placed.reduce((tallest, entry) => Math.max(tallest, entry.y), 0) + NODE_H,
  };
}

export function RoutingMap({
  data,
  empty,
}: {
  data: RoutingMapData;
  /** What to say instead when there is nothing to draw. */
  empty?: ReactNode;
}) {
  const { placed, height } = useMemo(() => place(data), [data]);
  const byId = useMemo(
    () => new Map(placed.map((entry) => [entry.node.id, entry])),
    [placed]
  );

  if (placed.length === 0) return <>{empty}</>;

  const width =
    data.columns.reduce((sum, _, index) => sum + (WIDTHS[index] ?? 180), 0) +
    GAP * Math.max(0, data.columns.length - 1);

  return (
    // Scrolled rather than squeezed: the columns are sized to hold a hostname
    // and a namespace, and a narrow window is a reason to pan, not a reason
    // to clip every name on the screen.
    <div className="overflow-x-auto pb-1">
      <div style={{ width }}>
        <div className="flex" style={{ gap: GAP }}>
          {data.columns.map((column, index) => (
            <span
              key={column.label}
              style={{ width: WIDTHS[index] ?? 180 }}
              className="text-[9.5px] uppercase tracking-[0.08em] text-fg-fnt"
            >
              {column.label}
            </span>
          ))}
        </div>
        <div
          className="relative"
          style={{ width, height, marginTop: HEADER_H - 12 }}
        >
          {/* Decorative: every edge restates a link the nodes themselves
              already carry, and both ends are reachable with the keyboard. */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            width={width}
            height={height}
          >
            {data.edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + from.width;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const bend = (x2 - x1) / 2;
              return (
                <path
                  key={`${edge.from}->${edge.to}`}
                  d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                  className={cn("fill-none", EDGE_TEXT[edge.tone])}
                  stroke="currentColor"
                  strokeWidth={edge.tone === "err" ? 1.5 : 1}
                />
              );
            })}
          </svg>
          {placed.map((entry) => (
            <Node key={entry.node.id} at={entry} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Node({ at }: { at: Placed }) {
  const { node } = at;
  const body = (
    <>
      <span className="flex items-baseline gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
            TONE_TEXT[node.tone]
          )}
        >
          {node.label}
        </span>
        {node.tag && (
          <span
            className={cn(
              "flex-none text-[9.5px] uppercase tracking-wider",
              TONE_TEXT[node.tag.tone]
            )}
          >
            {node.tag.text}
          </span>
        )}
      </span>
      {node.sub && (
        <span className="mt-0.5 block truncate text-[10px] text-fg-fnt">
          {node.sub}
        </span>
      )}
    </>
  );

  const shell = cn(
    "absolute flex flex-col justify-center rounded-[5px] border bg-hover px-2 py-1 text-left",
    TONE_BORDER[node.tone]
  );
  const box = {
    left: at.x,
    top: at.y,
    width: at.width,
    height: NODE_H,
  } as const;

  const clickable = cn(
    shell,
    "transition-colors hover:border-info hover:bg-sel focus-visible:border-info focus-visible:outline-hidden"
  );

  // Asked before the element is built: `ObjectLink` renders nothing for an
  // object it cannot address, and a node that vanished would leave an edge
  // pointing at empty space.
  if (
    node.object &&
    objectUrl(node.object.kind, node.object.name, node.object.namespace) !==
      null
  ) {
    return (
      <ObjectLink
        {...node.object}
        className={clickable}
        style={box}
        title={node.label}
      >
        {body}
      </ObjectLink>
    );
  }

  if (!node.to) {
    return (
      <div className={shell} style={box} title={node.label}>
        {body}
      </div>
    );
  }

  return (
    <Link to={node.to} className={clickable} style={box} title={node.label}>
      {body}
    </Link>
  );
}
