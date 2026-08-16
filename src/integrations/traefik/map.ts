/**
 * Traefik's routing, as the three columns a request crosses.
 *
 * Entry point → host → service, and nothing between them: the middleware
 * chain is per-path rather than per-host, and a fourth column carrying "2
 * middlewares" for a host with twenty paths would be a number about nothing.
 * The chain under the host row on the Routes tab is where a single path is
 * read in full; this is where the *shape* is.
 *
 * The pods are not a column either. A Service and what it publishes are one
 * fact — "`api` in `shop`, 0 ready" is the sentence, and splitting it across
 * a line makes the reader join two boxes to read one thing — so the count
 * rides on the Service node as its tag.
 */

import { ResourceType } from "@/lib/resource-registry";

import type { MapEdge, MapNode, MapTone, RoutingMapData } from "../routing-map";
import {
  backingOf,
  boundEntryPoints,
  type HostGroup,
  type TraefikSources,
} from "./model";

const hostId = (group: HostGroup, index: number) =>
  `host/${group.host ?? `catch-all-${index}`}`;

/** Where clicking a host goes: its own routes, filtered to it. */
export const hostFilterPath = (host: string | null) =>
  `?tab=routes${host ? `&q=${encodeURIComponent(host)}` : ""}`;

function toneOf(group: HostGroup): MapTone {
  if (group.worst === "err") return "err";
  if (group.worst === "warn") return "warn";
  return "ok";
}

/**
 * Where the controller says this host is reachable.
 *
 * Read off `status.loadBalancer.ingress` on the Ingresses this group came
 * from — already in the list the page fetched, so it costs nothing. An
 * IngressRoute contributes none: Traefik's CRD carries no status address at
 * all, and inventing one from the proxy's Service would be this page guessing
 * at something the object does not say.
 */
function publishedAt(group: HostGroup, sources: TraefikSources): string[] {
  const names = new Set(
    group.routes
      .filter((route) => route.source.kind === "Ingress")
      .map((route) => `${route.source.namespace}/${route.source.name}`)
  );
  return [
    ...new Set(
      sources.ingresses
        .filter((ingress) => names.has(`${ingress.namespace}/${ingress.name}`))
        .flatMap((ingress) => ingress.loadBalancerIps)
    ),
  ];
}

export function routingMap(
  groups: HostGroup[],
  sources: TraefikSources
): RoutingMapData {
  const entryPoints = new Map<string, MapNode>();
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
    const id = hostId(group, index);
    const tls = group.tlsSecrets[0];
    const tone = toneOf(group);

    for (const route of group.routes) {
      for (const entry of boundEntryPoints(route, sources.entryPoints)) {
        const entryId = `entry/${entry.name}`;
        if (!entryPoints.has(entryId)) {
          entryPoints.set(entryId, {
            id: entryId,
            label: entry.name,
            sub: [entry.address, entry.tls ? "TLS" : null]
              .filter(Boolean)
              .join(" · "),
            tone: "mute",
          });
        }
        link(entryId, id, tone);
      }

      // Only a real Service gets a node. Traefik's own internals have no
      // endpoints by design and an API-object backend cannot be seen into;
      // drawing either as a backend that publishes nothing would be the map
      // inventing an outage out of a supported configuration.
      const service = route.service;
      if (!service?.kubernetes) continue;
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

    const at = publishedAt(group, sources);
    return {
      id,
      label: group.host ?? "any host",
      // The address the hostname has to resolve to, beside the path count.
      // Without it the column is a list of names somebody still has to go and
      // look up one at a time, which is the errand a map is supposed to end.
      sub: [
        `${group.routes.length} path${group.routes.length === 1 ? "" : "s"}`,
        at.length > 0 ? at.join(", ") : null,
      ]
        .filter(Boolean)
        .join(" · "),
      tone,
      to: hostFilterPath(group.host),
      tag: tls
        ? { text: "TLS", tone: tone === "err" ? "err" : "mute" }
        : { text: "no TLS", tone: "warn" },
    };
  });

  return {
    columns: [
      { label: "Entry point", nodes: [...entryPoints.values()] },
      { label: "Host", nodes: hosts },
      { label: "Service", nodes: [...services.values()] },
    ],
    edges,
  };
}
