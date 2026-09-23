/**
 * Whether something in front of a proxy serves a host over TLS — one answer
 * for the proxy's own page and for every surface that reads its routes.
 *
 * The page asks `ingress.tls` about the Ingresses in front and the proxy's
 * Service for its own routes; the Service page, the peek and the Argo CD page
 * read `service.routes`, whose Traefik answer sees only `spec.tls`. Asked
 * separately, an ALB's ACM certificate read "TLS ends at the edge" on one
 * screen and `http://` on the next.
 */

import type { Capabilities, ServiceRoute } from "@/integrations";

/** Whether something in front terminates TLS, or `"unknown"` until it is read. */
export type FrontingTls = boolean | "unknown";

export function frontingVerdict(
  host: string,
  answers: {
    /** What `ingress.tls` said about the host, per Ingress in front. */
    said: ReadonlyArray<boolean | null | undefined>;
    /** The proxy's own Service's routes. */
    routes: readonly ServiceRoute[];
    /** A read that failed or has not come back. */
    unanswered: boolean;
  }
): FrontingTls {
  const mine = answers.routes.filter((route) => route.host === host);
  if (answers.said.includes(true) || mine.some((route) => route.tls === true))
    return true;
  // A supplier that read too little to say has not said no.
  const unsure =
    answers.said.includes(null) || mine.some((route) => route.tls === null);
  return answers.unanswered || unsure ? "unknown" : false;
}

const refKey = (ref: { namespace: string; name: string }) =>
  `${ref.namespace}/${ref.name}`;

/**
 * The routes with the fronting question answered: `true` where something in
 * front terminates the host, `null` where it could not be ruled out.
 */
export async function settleFrontedRoutes(
  routes: ServiceRoute[],
  ask: {
    ingressTls: ReadonlyArray<Capabilities["ingress.tls"]>;
    serviceRoutes: ReadonlyArray<Capabilities["service.routes"]>;
  }
): Promise<ServiceRoute[]> {
  const ingresses = new Map<
    string,
    { namespace: string; name: string; hosts: string[] }
  >();
  const proxies = new Map<string, { namespace: string; name: string }>();
  for (const { front, tls, host } of routes) {
    if (!front || tls === true) continue;
    for (const ingress of front.ingresses) {
      const at = ingresses.get(refKey(ingress)) ?? { ...ingress, hosts: [] };
      if (!at.hosts.includes(host)) at.hosts.push(host);
      ingresses.set(refKey(ingress), at);
    }
    proxies.set(refKey(front.proxy), front.proxy);
  }
  if (proxies.size === 0) return routes;
  const wanted = [...ingresses.values()];

  // A failure is kept with what it failed to answer: every supplier of
  // `ingress.tls` is asked about every Ingress in front, but a proxy's routes
  // are its own, and one proxy that could not be read is no reason to doubt
  // another's answer.
  let tlsUnanswered = false;
  const proxiesUnanswered = new Set<string>();
  const settled = <T>(
    promise: Promise<T>,
    failed: () => void
  ): Promise<T | null> =>
    promise.catch(() => {
      failed();
      return null;
    });
  const [tls, fronting] = await Promise.all([
    Promise.all(
      wanted.length === 0
        ? []
        : ask.ingressTls.map((supplier) =>
            settled(supplier(wanted), () => (tlsUnanswered = true))
          )
    ),
    Promise.all(
      [...proxies.values()].map(async (proxy) => ({
        proxy: refKey(proxy),
        routes: (
          await Promise.all(
            ask.serviceRoutes.map((supplier) =>
              settled(supplier(proxy), () =>
                proxiesUnanswered.add(refKey(proxy))
              )
            )
          )
        ).flatMap((answer) => answer ?? []),
      }))
    ),
  ]);

  return routes.map((route) => {
    if (!route.front || route.tls === true) return route;
    const front = route.front;
    const fronts = new Set(front.ingresses.map(refKey));
    const said = tls.flatMap((answer) =>
      wanted.flatMap((ingress, position) =>
        fronts.has(refKey(ingress))
          ? (answer?.[position] ?? [])
              .filter((entry) => entry.host === route.host)
              .map((entry) => entry.terminated)
          : []
      )
    );
    const verdict = frontingVerdict(route.host, {
      said,
      routes:
        fronting.find((entry) => entry.proxy === refKey(front.proxy))?.routes ??
        [],
      unanswered:
        (tlsUnanswered && fronts.size > 0) ||
        proxiesUnanswered.has(refKey(front.proxy)),
    });
    if (verdict === true) return { ...route, tls: true };
    if (verdict === "unknown") return { ...route, tls: null };
    return route;
  });
}
