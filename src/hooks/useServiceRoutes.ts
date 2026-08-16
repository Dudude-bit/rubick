/**
 * Which hostnames from outside reach this Service, from whatever routes it.
 *
 * The core answer — an `Ingress` — is the caller's and arrives first; this
 * adds the ways in that live in a vendor's own objects, which the backend's
 * connection graph does not and should not know about. See `service.routes`.
 */

import { useQueries, useQuery } from "@tanstack/react-query";

import { useCapabilities, type ServiceRoute } from "@/integrations";

export interface ServiceRoutes {
  /**
   * Whether anything in this cluster can answer at all.
   *
   * `false` on a cluster whose edge is plain Ingresses, which is most of
   * them, and it is not an error: the caller's own reading of the Ingresses
   * is the whole answer there.
   */
  available: boolean;
  routes: ServiceRoute[];
  /** Still reading, so "no route" is not yet a thing anyone may say. */
  isPending: boolean;
  /**
   * A supplier that was installed and did not answer. The difference between
   * "nothing routes this" and "the app could not find out", which is the
   * exact difference this capability exists to stop the app getting wrong.
   */
  error: Error | null;
}

const NONE: ServiceRoute[] = [];

export function useServiceRoutes(
  service: { namespace: string; name: string } | null
): ServiceRoutes {
  const suppliers = useCapabilities("service.routes");
  const enabled = suppliers.length > 0 && service !== null;

  const query = useQuery({
    queryKey: [
      "service-routes",
      service?.namespace ?? "",
      service?.name ?? "",
      suppliers.length,
    ],
    queryFn: async () => {
      const answers = await Promise.all(
        suppliers.map((ask) =>
          ask({ namespace: service!.namespace, name: service!.name })
        )
      );
      return answers.flat();
    },
    enabled,
    // Routing changes with a deploy, not by the second — the same minute the
    // routing pages read at.
    staleTime: 60_000,
  });

  return {
    available: suppliers.length > 0,
    routes: query.data ?? NONE,
    isPending: enabled && query.isPending,
    error: (query.error as Error) ?? null,
  };
}

export interface ServicesRoutes {
  available: boolean;
  /** By `namespace/name`. A Service nothing routes is simply absent. */
  routes: Map<string, ServiceRoute[]>;
  isPending: boolean;
}

/**
 * The same answer for several Services at once — a traffic chain may front
 * one workload with more than one Service, and a hook cannot sit in a loop.
 * Shares {@link useServiceRoutes}'s query keys, so the two never double-ask.
 */
export function useServicesRoutes(
  services: Array<{ namespace: string; name: string }>
): ServicesRoutes {
  const suppliers = useCapabilities("service.routes");
  const enabled = suppliers.length > 0;

  const queries = useQueries({
    queries: services.map((service) => ({
      queryKey: [
        "service-routes",
        service.namespace,
        service.name,
        suppliers.length,
      ],
      queryFn: async () => {
        const answers = await Promise.all(
          suppliers.map((ask) =>
            ask({ namespace: service.namespace, name: service.name })
          )
        );
        return answers.flat();
      },
      enabled,
      staleTime: 60_000,
    })),
  });

  const routes = new Map<string, ServiceRoute[]>();
  services.forEach((service, index) => {
    const found = queries[index]?.data;
    if (found && found.length > 0) {
      routes.set(`${service.namespace}/${service.name}`, found);
    }
  });

  return {
    available: enabled,
    routes,
    isPending: enabled && queries.some((query) => query.isPending),
  };
}
