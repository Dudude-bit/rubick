/**
 * The mesh's routing, as the three columns a request crosses.
 *
 * Gateway → host → destination, and match rules nowhere: a match is
 * per-route the way Traefik's middleware is per-path, and the Routes tab is
 * where one rule is read in full. This is where the *shape* is — which
 * gateways carry which hostnames, and which of them land on the same
 * Service.
 *
 * An external destination keeps its node and loses only the link: traffic
 * leaving the mesh is part of the shape, and hiding it would draw a
 * VirtualService as routing nowhere.
 */

import { ResourceType } from "@/lib/resource-registry";

import type { MapEdge, MapNode, MapTone, RoutingMapData } from "../routing-map";
import { backingOf, type IstioHostGroup, type IstioSources } from "./model";

/** Where clicking a host goes: its own routes, filtered to it. */
export const hostFilterPath = (host: string) =>
  `?tab=routes&q=${encodeURIComponent(host)}`;

function toneOf(group: IstioHostGroup): MapTone {
  if (group.worst === "err") return "err";
  if (group.worst === "warn") return "warn";
  return "ok";
}

export function routingMap(
  groups: IstioHostGroup[],
  sources: IstioSources
): RoutingMapData {
  const gateways = new Map<string, MapNode>();
  const destinations = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const seen = new Set<string>();

  const link = (from: string, to: string, tone: MapTone) => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, tone });
  };

  const hosts = groups.map((group): MapNode => {
    const id = `host/${group.host}`;
    const tone = toneOf(group);

    for (const serving of group.gateways) {
      const gatewayId = `gateway/${serving.named}`;
      if (!gateways.has(gatewayId)) {
        gateways.set(gatewayId, {
          id: gatewayId,
          label: serving.named,
          sub: serving.ports.length > 0 ? serving.ports.join(" · ") : undefined,
          tone: "mute",
        });
      }
      // A named gateway that does not cover the host is the finding the
      // Routes tab spells out; here the line itself carries it.
      link(gatewayId, id, serving.serves ? tone : "err");
    }

    for (const route of group.routes) {
      for (const destination of route.destinations) {
        const service = destination.service;
        const destinationId = service
          ? `service/${service.namespace}/${service.name}`
          : `external/${destination.host}`;
        const backing = backingOf(destination, route.source, sources);
        if (!destinations.has(destinationId)) {
          destinations.set(destinationId, {
            id: destinationId,
            label: service ? service.name : destination.host,
            sub: service
              ? [
                  service.namespace,
                  destination.port ? `:${destination.port}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "outside the mesh",
            tone: service ? (backing.stop ? "err" : "ok") : "mute",
            object: service
              ? {
                  kind: ResourceType.Service,
                  name: service.name,
                  namespace: service.namespace,
                }
              : undefined,
            tag: !service
              ? undefined
              : !backing.known
                ? undefined
                : backing.stop
                  ? { text: "0 ready", tone: "err" }
                  : {
                      text: `${backing.ready + backing.draining} ready`,
                      tone: backing.ready === 0 ? "warn" : "mute",
                    },
          });
        }
        link(
          id,
          destinationId,
          backing.stop ? "err" : tone === "err" ? "warn" : "ok"
        );
      }
    }

    return {
      id,
      label: group.host,
      sub: `${group.routes.length} route${group.routes.length === 1 ? "" : "s"}`,
      tone,
      to: hostFilterPath(group.host),
      tag: group.meshOnly ? { text: "mesh only", tone: "mute" } : undefined,
    };
  });

  return {
    columns: [
      { label: "Gateway", nodes: [...gateways.values()], width: 200 },
      { label: "Host", nodes: hosts },
      { label: "Destination", nodes: [...destinations.values()] },
    ],
    edges,
  };
}
