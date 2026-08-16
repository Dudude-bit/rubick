/**
 * Traefik's answer to "which hostnames reach this Service".
 *
 * The whole file exists because the app's connection graph is built in the
 * backend out of `Ingress` objects and nothing else. That is the right call —
 * an edge out of an `IngressRoute` would put Traefik's object model in the
 * core — but it left every surface that asks "how is this reached" answering
 * from Ingresses alone and phrasing the answer as though it had asked the
 * cluster. On a cluster whose edge is entirely IngressRoutes, that is a page
 * telling the reader nothing routes to a Service they have been reaching by
 * name for months.
 *
 * Nothing here is new knowledge: `allRoutes` already reads both shapes for
 * the routing page, and both reads below share that page's query keys, so a
 * reader who has opened it pays for neither.
 */

import { commands } from "@/lib/commands";
import { crdObjectPath } from "../kit";
import { integrationPagePath } from "../paths";
import type { ProxyBehind, ServiceRoute } from "../registry";
import { fetchController, fetchRouteSources, servedGroupName } from "./data";
import {
  allRoutes,
  terminatedUpstream,
  type EntryPoint,
  type TraefikRoute,
} from "./model";

/**
 * Whether this route is served over TLS, or `null` where the objects do not
 * settle it.
 *
 * Read in the order the objects are authoritative. A Secret named for the
 * host is the end of the question; a `tls` block with no Secret still means
 * TLS, with Traefik's own default certificate. Only when the object says
 * nothing at all do the entry points decide it — and those live in the
 * proxy's start-up flags, so with none read the honest answer is that we do
 * not know rather than "plain HTTP".
 */
export function routeIsSecure(
  route: TraefikRoute,
  entryPoints: EntryPoint[]
): boolean | null {
  if (route.tlsSecret !== null || route.declaresTls) return true;
  if (entryPoints.length === 0) return null;
  // `null` is Traefik's "every entry point", not "none of them".
  const bound =
    route.entryPoints === null
      ? entryPoints
      : entryPoints.filter((entry) => route.entryPoints?.includes(entry.name));
  // A name the proxy does not define binds the router to nothing we can read.
  if (bound.length === 0) return null;
  return bound.some((entry) => entry.tls);
}

export async function serviceRoutes(input: {
  namespace: string;
  name: string;
}): Promise<ServiceRoute[]> {
  // The controller's flags and the Service list are the softer reads:
  // without them every answer below is still a real host, only with
  // `tls: null` on it. So a failure there costs the scheme, not the answer.
  const [sources, controller, services] = await Promise.all([
    fetchRouteSources(),
    fetchController().catch(() => null),
    commands.listServices(null).catch(() => []),
  ]);
  const entryPoints = controller?.entryPoints ?? [];
  const withServices = {
    ...sources,
    services,
    published: [],
    entryPoints,
  };

  const found = new Map<string, ServiceRoute>();
  for (const route of allRoutes(withServices)) {
    const service = route.service;
    if (!service?.kubernetes) continue;
    if (service.name !== input.name || service.namespace !== input.namespace) {
      continue;
    }
    const host = route.clause.host;
    // A route with no host term answers on whatever address reaches the
    // proxy, and there is no name to hand anybody.
    if (!host) continue;

    const path = route.clause.path?.value || "/";
    // One entry per host and path: the same pair reached through two objects
    // is one way in, and printing it twice says there are two.
    const key = `${host}${path}`;
    // The client-facing scheme first: a cloud load balancer terminating in
    // front of the proxy serves this host over TLS whatever entry point the
    // route itself binds — the inside hop is plaintext by arrangement.
    const secure =
      terminatedUpstream(host, withServices) !== null
        ? true
        : routeIsSecure(route, entryPoints);
    const h2c = service.scheme === "h2c";
    const already = found.get(key);
    if (already) {
      // Two objects disagreeing about the scheme means one of them serves it
      // over TLS, and a client that asks for TLS gets it.
      if (already.tls !== true && secure === true) {
        found.set(key, { ...already, tls: true, source: route.source });
      }
      continue;
    }
    found.set(key, {
      host,
      path,
      tls: secure,
      h2c,
      source: route.source,
      // Only this file knows which API group serves the CRD; a core kind
      // links itself.
      to:
        route.source.kind === "IngressRoute"
          ? crdObjectPath(
              `ingressroutes.${servedGroupName()}`,
              route.source.namespace,
              route.source.name
            )
          : undefined,
    });
  }

  return [...found.values()].sort(
    (left, right) =>
      left.host.localeCompare(right.host) || left.path.localeCompare(right.path)
  );
}

/**
 * Whether this Service is Traefik's own front door — and what stands
 * behind it. Recognised the same way the routing page recognises its
 * proxy: the label every Traefik chart puts on its own pods.
 */
export async function proxyBehind(input: {
  namespace: string;
  name: string;
}): Promise<ProxyBehind | null> {
  const services = await commands.listServices(null).catch(() => []);
  const named = services.find(
    (service) =>
      service.name === input.name && service.namespace === input.namespace
  );
  if (named?.selector["app.kubernetes.io/name"] !== "traefik") return null;

  const sources = await fetchRouteSources();
  const hosts = new Set(
    allRoutes({
      ...sources,
      services: [],
      published: [],
      entryPoints: [],
    }).flatMap((route) => (route.clause.host ? [route.clause.host] : []))
  );
  return {
    vendor: "Traefik",
    to: integrationPagePath("traefik"),
    hosts: hosts.size,
  };
}
