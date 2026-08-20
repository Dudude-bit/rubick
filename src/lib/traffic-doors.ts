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

import { findGateway, HOSTLESS_PROTO } from "@/lib/route-trace";
import type { T } from "@/i18n/useT";
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
  /** What a click puts on the clipboard: the hostname, or the dialable
   *  `address:port` for a hostless door. Null where nothing honest exists. */
  copy: string | null;
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

/** The break, compressed to the one word a door line can carry. */
function brokenWord(stop: ChainStop, t: T): string | null {
  switch (stop.reason) {
    case "routeNotAccepted":
      return t("empty", "gwRefusedWord");
    case "routeRefsUnresolved":
      return t("empty", "gwBrokenRefs");
    case "gatewayMissing":
      return t("empty", "gwGatewayMissingWord");
    default:
      return null;
  }
}

export function trafficDoors(
  conns: ResourceConnections,
  gateways: GatewayInfo[],
  t: T
): TrafficDoors {
  // What broke, and under which gateway. A refusal is a verdict about ONE
  // (route, gateway) pair — a route refused by one gateway may be serving
  // through another, and the healthy door must not wear the refusal.
  // Refs failures carry no gateway and apply to every door of the route.
  const brokenPerGateway = new Map<string, string>();
  const brokenPerRoute = new Map<string, string>();
  for (const stop of conns.stops) {
    const word = brokenWord(stop, t);
    if (!word || !("route" in stop)) continue;
    if ("gateway" in stop) {
      brokenPerGateway.set(`${key(stop.route)}@${key(stop.gateway)}`, word);
    } else {
      brokenPerRoute.set(key(stop.route), word);
    }
  }

  // EVERY gateway each route attaches to — a route with two parents is a
  // door under each of them, not under whichever edge came last.
  const gatewaysOf = new Map<
    string,
    Array<{ gateway: ObjectRef; sectionName: string | null }>
  >();
  for (const edge of conns.edges) {
    if (edge.relation.verb === "attachesTo" && edge.to.kind === "Gateway") {
      const at = key(edge.from);
      gatewaysOf.set(at, [
        ...(gatewaysOf.get(at) ?? []),
        { gateway: edge.to, sectionName: edge.relation.sectionName },
      ]);
    }
  }

  const entries = new Map<string, TrafficEntry>();
  const mesh: DoorRef[] = [];

  const entryFor = (object: ObjectRef, meta: string): TrafficEntry => {
    const at = key(object);
    const existing = entries.get(at);
    if (existing) return existing;
    const gateway =
      object.kind === "Gateway" && object.namespace != null
        ? findGateway(gateways, object.name, object.namespace)
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
      const attachments = gatewaysOf.get(key(edge.from)) ?? [];
      if (attachments.length === 0) {
        // No gateway parent in the graph: a mesh attachment (GAMMA).
        mesh.push(doorRef(edge.from));
        continue;
      }
      for (const { gateway, sectionName } of attachments) {
        const className =
          gateway.facts?.kind === "gateway" ? gateway.facts.className : null;
        const entry = entryFor(
          gateway,
          className
            ? t("empty", "gwDoorGatewayClass", { name: className })
            : "Gateway"
        );
        const broken =
          brokenPerGateway.get(`${key(edge.from)}@${key(gateway)}`) ??
          brokenPerRoute.get(key(edge.from)) ??
          (gateway.existence === "missing"
            ? t("empty", "gwGatewayMissingWord")
            : null);
        if (edge.relation.hostnames.length > 0) {
          for (const host of edge.relation.hostnames) {
            entry.doors.push({
              host,
              copy: host,
              broken,
              route: doorRef(edge.from),
              note: null,
            });
          }
        } else {
          // The door is the LISTENER's port — the relation's port is the
          // backendRef's, the service side, and must never pose as the door.
          // No sectionName and several listeners means guessing, so no claim.
          const proto = HOSTLESS_PROTO[edge.from.kind];
          const listeners =
            (gateway.namespace != null
              ? findGateway(gateways, gateway.name, gateway.namespace)
              : undefined
            )?.listeners ?? [];
          const listener = sectionName
            ? listeners.find((entry) => entry.name === sectionName)
            : listeners.length === 1
              ? listeners[0]
              : undefined;
          const address = entry.address;
          entry.doors.push({
            host: listener
              ? `:${listener.port}${proto ? ` ${proto}` : ""}`
              : (proto ?? edge.from.kind),
            // The dialable pair, where both halves are known — the label
            // alone dials nothing.
            copy: listener && address ? `${address}:${listener.port}` : null,
            broken,
            route: doorRef(edge.from),
            note: null,
          });
        }
      }
    }

    if (edge.relation.verb === "routes" && edge.from.kind === "Ingress") {
      const entry = entryFor(edge.from, "Ingress");
      entry.doors.push({
        host: edge.relation.host ?? t("empty", "gwAllHosts"),
        copy: edge.relation.host,
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
      const at = `${door.host}/${door.route ? `${door.route.kind}/${door.route.namespace ?? ""}/${door.route.name}` : ""}`;
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
