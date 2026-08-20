/**
 * The peek's traffic path, read as doors under their entries.
 *
 * A Service peek answers "how does traffic reach me" — so the unit is the
 * door (a hostname, or a port for the hostless kinds), stacked under the
 * entry that owns it: a Gateway with its address, or an Ingress. The stops
 * the backend already reports mark broken doors in one word; a Gateway
 * that is not there wears the ghost flag the routes list wears; mesh
 * parents are named in their own place, explicitly unjudged.
 */

import type {
  ChainStop,
  GatewayInfo,
  ObjectRef,
  ResourceConnections,
} from "@/generated/types";

export interface DoorRef {
  kind: string;
  name: string;
  namespace: string | null;
}

export interface TrafficDoor {
  /** The door itself: a hostname, or `:port` for the hostless kinds. */
  host: string;
  /** Hostnames paste into curl; a bare port label does not. */
  copyable: boolean;
  /** One-word verdict where the door is broken — null is healthy. */
  broken: string | null;
  /** The route to peek at, quiet on the right. */
  route: DoorRef | null;
  /** A short trailing note: the protocol, a path, a count. */
  note: string | null;
}

export interface TrafficEntry {
  object: DoorRef;
  /** Known missing — wears the dashed «?». */
  ghost: boolean;
  /** "Gateway · class envoy", "Ingress". */
  meta: string;
  /** The entry's own address, where one is known. */
  address: string | null;
  doors: TrafficDoor[];
  /** Doors beyond the cap, said as a count instead of a wall. */
  moreDoors: number;
}

export interface TrafficDoors {
  entries: TrafficEntry[];
  /** Mesh parents naming this service — real, and not judged here. */
  mesh: DoorRef[];
}

/** Six doors read; a seventh starts a wall the count says better. */
const DOOR_CAP = 6;

const doorRef = (object: ObjectRef): DoorRef => ({
  kind: object.kind,
  name: object.name,
  namespace: object.namespace,
});

const key = (object: ObjectRef) =>
  `${object.kind}/${object.namespace ?? ""}/${object.name}`;

const HOSTLESS_PROTO: Record<string, string> = {
  TCPRoute: "TCP",
  UDPRoute: "UDP",
  TLSRoute: "TLS",
};

/** The break, compressed to the one word a door line can carry. */
function brokenWord(stop: ChainStop): string | null {
  switch (stop.reason) {
    case "routeNotAccepted":
      return "refused";
    case "routeRefsUnresolved":
      return "broken refs";
    case "gatewayMissing":
      return "gateway missing";
    default:
      return null;
  }
}

export function trafficDoors(
  conns: ResourceConnections,
  gateways: GatewayInfo[]
): TrafficDoors {
  // What broke, per route — the stops already carry the route's identity.
  const brokenByRoute = new Map<string, string>();
  for (const stop of conns.stops) {
    const word = brokenWord(stop);
    if (word && "route" in stop) brokenByRoute.set(key(stop.route), word);
  }

  // Which gateway each route attaches to, and what the gateway is.
  const gatewayOf = new Map<string, ObjectRef>();
  for (const edge of conns.edges) {
    if (edge.relation.verb === "attachesTo" && edge.to.kind === "Gateway") {
      gatewayOf.set(key(edge.from), edge.to);
    }
  }

  const entries = new Map<string, TrafficEntry>();
  const mesh: DoorRef[] = [];

  const entryFor = (object: ObjectRef, meta: string): TrafficEntry => {
    const at = key(object);
    const existing = entries.get(at);
    if (existing) return existing;
    const gateway =
      object.kind === "Gateway"
        ? gateways.find(
            (candidate) =>
              candidate.name === object.name &&
              candidate.namespace === object.namespace
          )
        : undefined;
    const entry: TrafficEntry = {
      object: doorRef(object),
      ghost: object.existence === "missing",
      meta,
      address: gateway?.addresses[0] ?? null,
      doors: [],
      moreDoors: 0,
    };
    entries.set(at, entry);
    return entry;
  };

  for (const edge of conns.edges) {
    if (edge.relation.verb === "ruleRoutes") {
      const gateway = gatewayOf.get(key(edge.from));
      if (!gateway) {
        // No gateway parent in the graph: a mesh attachment (GAMMA).
        mesh.push(doorRef(edge.from));
        continue;
      }
      const className =
        gateway.facts?.kind === "gateway" ? gateway.facts.className : null;
      const entry = entryFor(
        gateway,
        className ? `Gateway · class ${className}` : "Gateway"
      );
      const broken =
        brokenByRoute.get(key(edge.from)) ??
        (gateway.existence === "missing" ? "gateway missing" : null);
      if (edge.relation.hostnames.length > 0) {
        for (const host of edge.relation.hostnames) {
          entry.doors.push({
            host,
            copyable: true,
            broken,
            route: doorRef(edge.from),
            note: null,
          });
        }
      } else {
        const proto = HOSTLESS_PROTO[edge.from.kind];
        entry.doors.push({
          host: edge.relation.port
            ? `:${edge.relation.port}${proto ? ` ${proto}` : ""}`
            : (proto ?? edge.from.kind),
          copyable: false,
          broken,
          route: doorRef(edge.from),
          note: null,
        });
      }
    }

    if (edge.relation.verb === "routes" && edge.from.kind === "Ingress") {
      const entry = entryFor(edge.from, "Ingress");
      entry.doors.push({
        host: edge.relation.host ?? "all hosts",
        copyable: edge.relation.host != null,
        broken: null,
        route: null,
        note:
          [edge.relation.path || null, edge.relation.tls ? "TLS" : null]
            .filter(Boolean)
            .join(" · ") || null,
      });
    }
  }

  for (const entry of entries.values()) {
    // Dedup doors a route names twice (one per rule), then cap — broken
    // first, so the hidden tail is never where the problem hides.
    const seen = new Set<string>();
    const doors = entry.doors.filter((door) => {
      const at = `${door.host}/${door.route ? `${door.route.kind}/${door.route.name}` : ""}`;
      if (seen.has(at)) return false;
      seen.add(at);
      return true;
    });
    doors.sort((a, b) => Number(b.broken != null) - Number(a.broken != null));
    entry.doors = doors.slice(0, DOOR_CAP);
    entry.moreDoors = doors.length - entry.doors.length;
  }

  return {
    // Present entries first, ghosts after — the working way in reads first.
    entries: [...entries.values()].sort(
      (a, b) => Number(a.ghost) - Number(b.ghost)
    ),
    mesh,
  };
}
