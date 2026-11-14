import { createContext, useContext } from "react";

import type { GraphEdge, GraphNode } from "./types";

/**
 * What every node and edge on one canvas asks of it. Stable for the life of
 * the canvas: a batch of new data must not redraw every node through its
 * context.
 */
export interface MapActions {
  open: (node: GraphNode, how: "peek" | "page") => void;
  openEdge?: (edge: GraphEdge) => void;
  toggle: (group: string) => void;
  /** The node under the pointer or the keyboard, which lights its neighbours. */
  setActive: (id: string | null) => void;
  /** Brings a node the keyboard reached into view. */
  reveal: (id: string) => void;
}

/** What is singled out: moves with the pointer and the search, not with the data. */
export interface MapLight {
  /** Whether a node is read alongside the active one or the search; `null` where nothing is singled out. */
  lit: (id: string) => boolean | null;
  /** Whether an edge touches the active node. */
  touched: (edge: GraphEdge) => boolean;
}

export const MapContext = createContext<MapActions | null>(null);
export const LightContext = createContext<MapLight>({
  lit: () => null,
  touched: () => false,
});

export function useActions(): MapActions {
  const actions = useContext(MapContext);
  if (!actions) throw new Error("a map part outside its canvas");
  return actions;
}

export const useLight = () => useContext(LightContext);
