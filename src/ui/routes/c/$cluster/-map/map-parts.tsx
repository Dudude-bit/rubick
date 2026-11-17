import { memo, type KeyboardEvent } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { KindIcon } from "@/components/object/KindIcon";
import { useT } from "@/i18n/useT";
import { cn } from "@/lib/utils";
import { useActions, useLight } from "./map-context";
import { EDGE_TEXT, NODE_BORDER, TONE_TEXT } from "./tone-classes";
import type { GraphEdge, GraphGroup, GraphNode } from "./types";

const HIDDEN_HANDLE = { opacity: 0, pointerEvents: "none" } as const;

function Handles() {
  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={HIDDEN_HANDLE}
      />
    </>
  );
}

export type ObjectNodeType = Node<{ node: GraphNode }, "object">;

/** One object: click or Space for the peek, double-click or Enter for its page. */
export const ObjectNode = memo(function ObjectNode({
  id,
  data,
}: NodeProps<ObjectNodeType>) {
  const actions = useActions();
  const light = useLight();
  const { node } = data;
  const lit = light.lit(id);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      actions.open(node, "page");
    } else if (event.key === " ") {
      event.preventDefault();
      actions.open(node, "peek");
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      title={node.label}
      aria-label={[node.kind, node.label, node.sub].filter(Boolean).join(", ")}
      data-node={id}
      className={cn(
        "flex h-full w-full cursor-pointer flex-col justify-center rounded-[5px] border bg-raise px-2 py-1 text-left transition-opacity duration-150",
        "hover:bg-hover focus-visible:border-info focus-visible:outline-hidden",
        NODE_BORDER[node.tone],
        lit === false && "opacity-25"
      )}
      onClick={() => actions.open(node, "peek")}
      onDoubleClick={() => actions.open(node, "page")}
      onKeyDown={onKey}
      onMouseEnter={() => actions.setActive(id)}
      onMouseLeave={() => actions.setActive(null)}
      onFocus={() => {
        actions.setActive(id);
        actions.reveal(id);
      }}
      onBlur={() => actions.setActive(null)}
    >
      <Handles />
      <span className="flex min-w-0 items-center gap-1.5">
        <KindIcon kind={node.kind} crd={node.crd ?? null} className="h-3 w-3" />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[11.5px]",
            node.tone === "err" || node.tone === "warn"
              ? TONE_TEXT[node.tone]
              : "text-fg"
          )}
        >
          {node.label}
        </span>
        {node.badge && (
          <span
            className={cn(
              "flex-none text-[9.5px] uppercase tracking-wider",
              TONE_TEXT[node.badge.tone]
            )}
          >
            {node.badge.text}
          </span>
        )}
      </span>
      {node.sub && (
        <span className="mt-0.5 block truncate text-[10px] text-fg-fnt">
          {node.sub}
        </span>
      )}
    </div>
  );
});

export type GroupNodeType = Node<{ group: GraphGroup }, "frame" | "card">;

const HATCH = {
  backgroundImage:
    "repeating-linear-gradient(135deg, hsl(var(--hair)) 0 1px, transparent 1px 9px)",
};

function GroupTitle({ group }: { group: GraphGroup }) {
  const t = useT();
  const actions = useActions();
  const Chevron = group.collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      className="flex min-w-0 items-center gap-1 rounded-sm text-left focus-visible:outline-1 focus-visible:outline-info"
      aria-expanded={!group.collapsed}
      aria-label={t(
        "topology",
        group.collapsed ? "expandGroup" : "collapseGroup",
        { name: group.label }
      )}
      onClick={(event) => {
        event.stopPropagation();
        actions.toggle(group.id);
      }}
    >
      <Chevron className="h-3.5 w-3.5 flex-none text-fg-fnt" aria-hidden />
      <span
        className={cn(
          "truncate text-[12px] font-semibold",
          group.tone === "err" || group.tone === "warn"
            ? TONE_TEXT[group.tone]
            : "text-fg"
        )}
      >
        {group.label}
      </span>
    </button>
  );
}

/** An expanded group: a frame its nodes sit in. */
export const GroupFrame = memo(function GroupFrame({
  data,
}: NodeProps<GroupNodeType>) {
  const { group } = data;
  return (
    <div
      className="h-full w-full rounded-lg border border-hair bg-canvas/40"
      style={group.refused ? HATCH : undefined}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5">
        <GroupTitle group={group} />
      </div>
      {group.refused && (
        <div className="px-3 pt-1 text-[10.5px] text-fg-mut">
          {group.summary}
        </div>
      )}
    </div>
  );
});

/** A collapsed group: its title and what it holds, in one card. */
export const GroupCard = memo(function GroupCard({
  data,
}: NodeProps<GroupNodeType>) {
  const { group } = data;
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col gap-1 rounded-lg border bg-raise px-3 py-2.5",
        NODE_BORDER[group.tone]
      )}
      style={group.refused ? HATCH : undefined}
    >
      <Handles />
      <GroupTitle group={group} />
      <div className="min-h-0 overflow-hidden text-[10.5px] leading-snug text-fg-mut">
        {group.summary}
      </div>
    </div>
  );
});

export type MapEdgeType = Edge<{ edge: GraphEdge }, "map">;

/** One line, its words beside it while either end is singled out. */
export const MapEdge = memo(function MapEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<MapEdgeType>) {
  const actions = useActions();
  const light = useLight();
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  if (!data) return null;
  const { edge } = data;
  const touched = light.touched(edge);
  const quiet = light.lit(edge.from) === false && light.lit(edge.to) === false;
  const width = 1 + 3 * Math.min(1, Math.max(0, edge.weight ?? 0));
  const words = [edge.label, edge.sub].filter(Boolean);
  return (
    <>
      <BaseEdge
        path={path}
        className={cn(
          "transition-opacity duration-150",
          touched ? "text-info/80" : EDGE_TEXT[edge.tone],
          edge.flow === "forward" && "map-flow",
          quiet && !touched && "opacity-20"
        )}
        style={{
          stroke: "currentColor",
          strokeWidth: touched ? width + 0.5 : width,
          strokeDasharray:
            edge.tone === "unknown" && edge.flow !== "forward"
              ? "3 3"
              : undefined,
        }}
      />
      {(actions.openEdge || (touched && words.length > 0)) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-auto absolute"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {actions.openEdge ? (
              <button
                type="button"
                aria-label={words.join(", ") || edge.id}
                className={cn(
                  "group flex items-center gap-1 rounded-sm border border-hair bg-raise px-1 text-[10px] text-fg-mut",
                  "focus-visible:border-info focus-visible:outline-hidden"
                )}
                onClick={() => actions.openEdge?.(edge)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    actions.openEdge?.(edge);
                  }
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full bg-fg-fnt"
                  aria-hidden
                />
                <span
                  className={cn(
                    "whitespace-nowrap",
                    !touched &&
                      "hidden group-hover:inline group-focus-visible:inline"
                  )}
                >
                  {words.join(" · ")}
                </span>
              </button>
            ) : (
              <span className="whitespace-nowrap rounded-sm bg-raise/90 px-1 text-[10px] text-fg-mut">
                {words.join(" · ")}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
