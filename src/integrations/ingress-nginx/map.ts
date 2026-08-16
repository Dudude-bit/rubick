/**
 * nginx's routing, as the two columns a request crosses.
 *
 * Host → service, and no entry-point column: nginx listens on 80 and 443
 * and nothing else, so a left column would carry the same two words beside
 * every host. A canary rides its host as a tag rather than a node — it is
 * the same hostname served twice, not a second place a request goes.
 */

import { ResourceType } from "@/lib/resource-registry";

import type { MapEdge, MapNode, MapTone, RoutingMapData } from "../routing-map";
import { backingOf, type NginxHostGroup, type NginxSources } from "./model";

/** Where clicking a host goes: its own routes, filtered to it. */
export const hostFilterPath = (host: string | null) =>
  `?tab=routes${host ? `&q=${encodeURIComponent(host)}` : ""}`;

function toneOf(group: NginxHostGroup): MapTone {
  if (group.worst === "err") return "err";
  if (group.worst === "warn") return "warn";
  return "ok";
}

export function routingMap(
  groups: NginxHostGroup[],
  sources: NginxSources
): RoutingMapData {
  const services = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const seen = new Set<string>();

  const link = (from: string, to: string, tone: MapTone) => {
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, tone });
  };

  const hosts = groups.map((group, index): MapNode => {
    const id = `host/${group.host ?? `catch-all-${index}`}`;
    const tone = toneOf(group);

    for (const route of group.routes) {
      // Only a real Service gets a node — an API-object backend cannot be
      // seen into, and drawing it as a backend publishing nothing would be
      // the map inventing an outage.
      const service = route.service;
      if (!service) continue;
      const serviceId = `service/${service.namespace}/${service.name}`;
      const backing = backingOf(route, sources);
      if (!services.has(serviceId)) {
        services.set(serviceId, {
          id: serviceId,
          label: service.name,
          sub: `${service.namespace}${service.port ? ` · :${service.port}` : ""}`,
          tone: backing.stop ? "err" : "ok",
          object: {
            kind: ResourceType.Service,
            name: service.name,
            namespace: service.namespace,
          },
          tag: !backing.known
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
        serviceId,
        backing.stop ? "err" : tone === "err" ? "warn" : "ok"
      );
    }

    return {
      id,
      label: group.host ?? "any host",
      sub: `${group.routes.length} path${group.routes.length === 1 ? "" : "s"}`,
      tone,
      to: hostFilterPath(group.host),
      // The split outranks TLS for the one word this node gets: a host
      // quietly serving two versions is the fact a reader scans for.
      tag: group.split
        ? {
            text:
              group.split.primaryShare === null
                ? "canary"
                : `${group.split.weightTotal - group.split.primaryShare}% canary`,
            tone: "warn",
          }
        : group.tlsSecrets.length > 0
          ? { text: "TLS", tone: tone === "err" ? "err" : "mute" }
          : { text: "no TLS", tone: "warn" },
    };
  });

  return {
    columns: [
      { label: "Host", nodes: hosts, width: 216 },
      { label: "Service", nodes: [...services.values()] },
    ],
    edges,
  };
}
