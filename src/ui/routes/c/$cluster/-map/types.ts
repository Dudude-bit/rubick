import type { ReactNode } from "react";

import type { MapTone } from "@/integrations";

export type { MapTone };

/** One object on a map. */
export interface GraphNode {
  /** Stable across updates; for a cluster object, `nodeId()` of it. */
  id: string;
  /** The group it is drawn in; `null` draws it outside every group. */
  group: string | null;
  kind: string;
  /** The CRD serving `kind`, for its mark; absent for a built-in kind. */
  crd?: string | null;
  /** The name, in mono. */
  label: string;
  /** One quieter line under it. */
  sub?: string;
  /** `unknown` draws the not-checked ring: nobody read it, so no colour is earned. */
  tone: MapTone;
  badge?: { text: string; tone: MapTone };
  /** Its place left to right inside its group, lower first; ties keep the order handed. */
  rank?: number;
}

/** The quieter line under a node's name: its kind, then what is known of it. */
export const subLine = (node: GraphNode): string =>
  [node.kind, node.sub].filter(Boolean).join(" · ");

/** One line between two nodes. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  /** `unknown` is dashed. */
  tone: MapTone;
  /** 0 to 1, drawn 1 to 4 px wide; absent is the thinnest. */
  weight?: number;
  /** `forward` moves dashes from `from` to `to`; still under reduced motion. */
  flow?: "forward" | "none";
  /** Shown while the edge is under the pointer or the keyboard. */
  label?: string;
  /** A second line beside the label: a rate and an error share. */
  sub?: string;
  /** Whether it decides where its ends sit; true unless said otherwise. */
  shapesLayout?: boolean;
  /** Lays out and is drawn as `to` before `from`: a route attaching to its Gateway. */
  reversed?: boolean;
}

/** A card of nodes: a namespace, an app. */
export interface GraphGroup {
  id: string;
  label: string;
  /** Drawn as a card of `summary`, its nodes and their edges folded into it. */
  collapsed: boolean;
  tone: MapTone;
  /** What a collapsed card says: counts by kind, its problems, what was not read. */
  summary: ReactNode;
  /** Drawn hatched: nothing in it could be read. */
  refused?: boolean;
}

/** What the page holding a canvas can ask of it. */
export interface GraphCanvasHandle {
  fit(): void;
  /** Pans to a node, expanded or not. */
  centre(id: string): void;
  /** The drawing as it stands, as an SVG document. */
  toSvg(): string;
}
