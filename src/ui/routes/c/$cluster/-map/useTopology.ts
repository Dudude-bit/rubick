import { useEffect, useState, useSyncExternalStore } from "react";

import type {
  MapKindState,
  NamespaceRead,
  TopologyEdge,
  TopologyEnd,
  TopologyNode,
  TopologyPiece,
} from "@/generated/types";
import { commands } from "@/lib/commands";
import {
  credentialsExpired,
  expiryReason,
  isCredentialsExpired,
} from "@/lib/credentials";
import { listenAll, listenBridgeLag, listenEvent } from "@/lib/events";
import { currentConnection } from "@/lib/refusals";
import { perf } from "@/lib/perf";
import { useClusterStore } from "@/stores/clusterStore";

export interface TopologySnapshot {
  /** `opening` until the first batch, `ready` once the scope was drawn whole. */
  phase: "opening" | "drawing" | "ready" | "ended";
  nodes: ReadonlyMap<string, TopologyNode>;
  edges: ReadonlyMap<string, TopologyEdge>;
  /** How each namespace drawn was read. */
  reads: ReadonlyMap<string, NamespaceRead>;
  kinds: readonly MapKindState[];
  end: TopologyEnd | null;
  /** Why the stream could not be opened. */
  error: unknown;
  /** Moves with every change, for a memo to key on. */
  version: number;
  /**
   * How many objects the map held when first drawn whole, `null` before.
   * Kept through a reopen, so what was decided once the map was whole is
   * not decided again by a reset or by the count moving past a line.
   */
  firstWhole: number | null;
}

const EMPTY: TopologySnapshot = {
  phase: "opening",
  nodes: new Map(),
  edges: new Map(),
  reads: new Map(),
  kinds: [],
  end: null,
  error: null,
  version: 0,
  firstWhole: null,
};

/**
 * What a map stream has sent, applied piece by piece. A piece replaces only
 * its own entry, so every node a batch did not name keeps its identity and
 * its memoised drawing.
 */
export class TopologyStore {
  private nodes = new Map<string, TopologyNode>();
  private edges = new Map<string, TopologyEdge>();
  private reads = new Map<string, NamespaceRead>();
  private current: TopologySnapshot = EMPTY;
  private heard = new Set<() => void>();
  private due = false;

  subscribe = (listener: () => void) => {
    this.heard.add(listener);
    return () => void this.heard.delete(listener);
  };

  snapshot = () => this.current;

  reset() {
    this.nodes = new Map();
    this.edges = new Map();
    this.reads = new Map();
    this.publish({
      ...EMPTY,
      version: this.current.version + 1,
      firstWhole: this.current.firstWhole,
    });
  }

  apply(pieces: readonly TopologyPiece[]) {
    const started = perf.recording ? performance.now() : 0;
    // New maps, the same node objects: a reader keyed on the map sees it
    // change, and a node no piece named is still the object it was.
    this.nodes = new Map(this.nodes);
    this.edges = new Map(this.edges);
    this.reads = new Map(this.reads);
    let kinds = this.current.kinds;
    for (const piece of pieces) {
      switch (piece.is) {
        case "node":
          this.nodes.set(piece.node.id, piece.node);
          break;
        case "edge":
          this.edges.set(piece.edge.id, piece.edge);
          break;
        case "nodeGone":
          this.nodes.delete(piece.id);
          break;
        case "edgeGone":
          this.edges.delete(piece.id);
          break;
        case "namespace":
          this.reads.set(piece.read.namespace, piece.read);
          break;
        case "namespaceGone":
          this.reads.delete(piece.namespace);
          break;
        case "kinds":
          kinds = piece.kinds;
          break;
      }
    }
    this.publish({
      ...this.current,
      phase: this.current.phase === "opening" ? "drawing" : this.current.phase,
      nodes: this.nodes,
      edges: this.edges,
      reads: this.reads,
      kinds,
      version: this.current.version + 1,
    });
    if (perf.recording) {
      const at = performance.now();
      perf.record({
        kind: "ipc",
        name: "topologyBatch (apply)",
        ms: at - started,
        at,
        rows: pieces.length,
      });
    }
  }

  ready() {
    this.publish({
      ...this.current,
      phase: "ready",
      version: this.current.version + 1,
      firstWhole: this.current.firstWhole ?? this.nodes.size,
    });
  }

  ended(end: TopologyEnd) {
    this.publish({
      ...this.current,
      phase: "ended",
      end,
      version: this.current.version + 1,
    });
  }

  failed(error: unknown) {
    this.publish({
      ...this.current,
      phase: "ended",
      error,
      version: this.current.version + 1,
    });
  }

  /** One render per frame, however many batches arrived in it. */
  private publish(next: TopologySnapshot) {
    this.current = next;
    if (this.due) return;
    this.due = true;
    const tell = () => {
      this.due = false;
      for (const listener of this.heard) listener();
    };
    if (typeof requestAnimationFrame === "function")
      requestAnimationFrame(tell);
    else queueMicrotask(tell);
  }
}

/**
 * The map of `scope` (`null` for every namespace), streamed and kept up to
 * date. A stream the backend ended because the cluster's client was
 * replaced is opened again, and so is one the bridge dropped events of.
 */
export function useTopology(
  scope: string[] | null,
  enabled = true
): TopologySnapshot {
  const [store] = useState(() => new TopologyStore());
  const context = useClusterStore((s) => s.currentContext);
  const [attempt, setAttempt] = useState(0);
  const scopeKey = scope === null ? "\u0000all" : scope.join(",");

  useEffect(() => {
    if (!enabled || !context) return;
    store.reset();
    let id: string | null = null;
    let left = false;
    let again: ReturnType<typeof setTimeout> | null = null;
    const connection = currentConnection();
    const reopen = (waitMs: number) => {
      if (left || again) return;
      again = setTimeout(() => setAttempt((n) => n + 1), waitMs);
    };
    const listening = listenAll([
      listenEvent("topology-batch", ({ payload }) => {
        if (payload.stream_id === id) store.apply(payload.pieces);
      }),
      listenEvent("topology-ready", ({ payload }) => {
        if (payload.stream_id === id) store.ready();
      }),
      listenEvent("topology-ended", ({ payload }) => {
        if (payload.stream_id !== id || left) return;
        const { end } = payload;
        if (end.says === "failed" && isCredentialsExpired(end.said))
          credentialsExpired(expiryReason(end.said), connection);
        store.ended(end);
        if (end.says === "replaced") reopen(0);
      }),
      // A lost batch leaves the held map wrong with nothing to say so: the
      // stream is opened again, after the wait the bridge asks for.
      listenBridgeLag((_missed, waitMs) => reopen(waitMs)),
    ]);
    void (async () => {
      try {
        await listening;
        if (left) return;
        const opened = await commands.openTopology(
          scopeKey === "\u0000all" ? null : scopeKey.split(",")
        );
        if (left) {
          void commands.closeTopology(opened).catch(() => {});
          return;
        }
        id = opened;
        await commands.topologySubscribed(opened);
      } catch (error) {
        if (!left) store.failed(error);
      }
    })();
    return () => {
      left = true;
      if (again) clearTimeout(again);
      listening.then(
        (off) => off(),
        () => {}
      );
      if (id) void commands.closeTopology(id).catch(() => {});
    };
  }, [store, enabled, context, scopeKey, attempt]);

  return useSyncExternalStore(store.subscribe, store.snapshot);
}
