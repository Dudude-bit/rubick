/**
 * The Routes and Gateways pages' verdicts, as the map reads them: one reader
 * of a route's and a Gateway's state, so the map never draws green what the
 * Routes page calls not serving, or a Gateway fine whose class nothing
 * claims.
 */

import type { GatewayInfo, TopologyNode } from "@/generated/types";
import type { MapTone } from "@/integrations";
import type { T } from "@/i18n/useT";
import { errorToShow } from "@/lib/error-utils";
import type { RoutesBoard } from "@/lib/route-rows";

export interface MapVerdict {
  tone: MapTone;
  /** The page's words for it, where it has some. */
  say: string | null;
}

export interface MapVerdicts {
  /** The route's row on the Routes page, `null` where it has none. */
  route(ref: {
    kind: string;
    name: string;
    namespace: string;
  }): MapVerdict | null;
  /**
   * What the Gateways page holds against the Gateway itself (its class, its
   * programming), `null` where it holds nothing: its own row then speaks.
   */
  gateway(namespace: string, name: string): MapVerdict | null;
  /** Every Gateway in the cluster, as the Routes page read it; `undefined` until read. */
  gateways: readonly GatewayInfo[] | undefined;
}

const key = (namespace: string, name: string, kind = "Gateway") =>
  `${kind}/${namespace}/${name}`;

export function mapVerdicts(
  board: RoutesBoard,
  gateways: readonly GatewayInfo[] | undefined,
  topologyKnown: boolean
): MapVerdicts {
  const routes = new Map<string, MapVerdict>();
  for (const row of board.notServing)
    routes.set(key(row.namespace, row.name, row.kind), {
      tone: "err",
      say: row.stop?.short ?? null,
    });
  for (const row of board.unknown)
    routes.set(key(row.namespace, row.name, row.kind), {
      tone: "unknown",
      say: null,
    });
  for (const row of board.serving)
    routes.set(key(row.namespace, row.name, row.kind), {
      tone: row.stale || row.contested ? "warn" : "ok",
      say: row.tail,
    });
  for (const row of board.mesh)
    routes.set(key(row.namespace, row.name, row.kind), {
      tone: "mute",
      say: row.tail,
    });
  const pulse = new Map(
    board.pulse.map((entry) => [
      key(entry.namespace, entry.gateway),
      { tone: "err" as const, say: entry.reason },
    ])
  );
  return {
    route: (ref) => routes.get(key(ref.namespace, ref.name, ref.kind)) ?? null,
    gateway: (namespace, name) =>
      pulse.get(key(namespace, name)) ??
      // Its class was not read: whether anything claims it is not known.
      (topologyKnown ? null : { tone: "unknown", say: null }),
    gateways: topologyKnown ? gateways : undefined,
  };
}

/** What the page says of a route or a Gateway node, for the line under it. */
export function verdictSay(
  verdicts: MapVerdicts,
  node: TopologyNode
): string | null {
  const { kind, name, namespace } = node.ref;
  if (node.verdict.says === "route")
    return (
      verdicts.route({ kind, name, namespace: namespace ?? "" })?.say ?? null
    );
  if (node.verdict.says === "gateway")
    return verdicts.gateway(namespace ?? "", name)?.say ?? null;
  return null;
}

/**
 * A Gateway a route names from outside what the map read, drawn as the
 * Routes page reads it: present with its row where the cluster-wide list
 * holds it, missing where that list answered without it. Every other node
 * is handed back as it was.
 */
export function withNamedGateways(
  nodes: ReadonlyMap<string, TopologyNode>,
  verdicts: MapVerdicts,
  held: WeakMap<TopologyNode, { from: unknown; node: TopologyNode }>
): ReadonlyMap<string, TopologyNode> {
  const listed = verdicts.gateways;
  if (!listed) return nodes;
  let out: Map<string, TopologyNode> | null = null;
  for (const [id, node] of nodes) {
    if (node.ref.kind !== "Gateway" || node.verdict.says === "gateway")
      continue;
    const row = listed.find(
      (gateway) =>
        gateway.name === node.ref.name &&
        gateway.namespace === node.ref.namespace
    );
    const was = held.get(node);
    const read =
      was && was.from === (row ?? listed)
        ? was.node
        : row
          ? {
              ...node,
              ref: { ...node.ref, existence: "present" as const },
              verdict: { says: "gateway" as const, row },
            }
          : {
              ...node,
              ref: { ...node.ref, existence: "missing" as const },
            };
    held.set(node, { from: row ?? listed, node: read });
    out ??= new Map(nodes);
    out.set(id, read);
  }
  return out ?? nodes;
}

/**
 * What the map says where a list its route and Gateway verdicts are judged
 * against failed, its last answer included: they are drawn not checked, and
 * the line says why. `null` where both were read.
 */
export function verdictsUnread(
  lists: { gateways: unknown; classes: unknown },
  t: T
): string | null {
  const failed = [
    lists.gateways != null && "Gateway",
    lists.classes != null && "GatewayClass",
  ].filter((kind): kind is string => kind !== false);
  if (failed.length === 0) return null;
  return t("topology", "verdictsUnread", {
    kinds: failed.join(", "),
    said: errorToShow(lists.gateways ?? lists.classes),
  });
}
