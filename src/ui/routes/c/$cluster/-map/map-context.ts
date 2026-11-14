import { createContext, useContext } from "react";

import type { GraphEdge, GraphNode } from "./types";

/** What every node and edge on one canvas asks of it. */
export interface MapActions {
  open: (node: GraphNode, how: "peek" | "page") => void;
  openEdge?: (edge: GraphEdge) => void;
  toggle: (group: string) => void;
  /** The node under the pointer or the keyboard, which lights its neighbours. */
  setActive: (id: string | null) => void;
  /** Brings a node the keyboard reached into view. */
  reveal: (id: string) => void;
  /** Whether a node is read alongside the active one or the search; `null` where nothing is singled out. */
  lit: (id: string) => boolean | null;
  /** Whether an edge touches the active node. */
  touched: (edge: GraphEdge) => boolean;
}

export const MapContext = createContext<MapActions | null>(null);

export function useActions(): MapActions {
  const actions = useContext(MapContext);
  if (!actions) throw new Error("a map part outside its canvas");
  return actions;
}
