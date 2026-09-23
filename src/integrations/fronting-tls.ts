import { useCallback, useMemo } from "react";

import type { IngressInfo, ServiceInfo } from "@/generated/types";
import { useIngressTls } from "@/hooks/useIngressTls";
import { useServiceRoutes } from "@/hooks/useServiceRoutes";
import {
  frontingIngressesOf,
  frontingQuestions,
  proxyServicesBy,
} from "./ingress";

/**
 * Whether something in front of the proxy serves this host over TLS.
 *
 * On a managed cluster the certificate is usually held by a cloud load
 * balancer and named in an annotation, so no amount of reading `spec.tls`
 * finds it and every host read as served in the clear. Two ways in: a route
 * the core already knows reaches the proxy's Service over TLS, or an Ingress
 * standing in front of it that a cloud controller says it terminates — an
 * ACM ARN or an Application Gateway certificate, neither of which is a route.
 *
 * `"unknown"` until the Services and both answers are in: a read that failed
 * or has not come back is not "nothing in front terminates it".
 */
export function useFrontingTls(
  ingresses: readonly IngressInfo[] | undefined,
  services: readonly ServiceInfo[] | undefined,
  proxyLabel: readonly [string, string],
  /** The hosts the proxy serves, which is what a hostless Ingress in front is asked about. */
  served: readonly string[]
): (host: string | null) => FrontingTls {
  const [labelKey, labelValue] = proxyLabel;
  const proxies = useMemo(
    () => proxyServicesBy(services ?? [], [labelKey, labelValue]),
    [services, labelKey, labelValue]
  );
  // Asking about the first is enough: a chart that installs two Services is
  // installing one proxy behind both.
  const proxy = useMemo(
    () =>
      proxies[0]
        ? { namespace: proxies[0].namespace, name: proxies[0].name }
        : null,
    [proxies]
  );
  const asked = useMemo(
    () =>
      frontingQuestions(
        frontingIngressesOf(ingresses ?? [], proxies),
        proxies,
        served
      ),
    [ingresses, proxies, served]
  );

  const fronting = useServiceRoutes(proxy);
  const front = useIngressTls(asked);
  const unanswered =
    services === undefined ||
    (proxy !== null && (fronting.isPending || fronting.error !== null)) ||
    (asked.length > 0 && (front.isPending || front.error !== null));
  return useCallback(
    (host: string | null): FrontingTls => {
      if (host === null) return unanswered ? "unknown" : false;
      const said = asked.map((ingress) => front.of(ingress, host)?.terminated);
      const terminated =
        said.includes(true) ||
        fronting.routes.some(
          (route) => route.tls === true && route.host === host
        );
      if (terminated) return true;
      // A supplier that read too little to say has not said no.
      const unsure =
        said.includes(null) ||
        fronting.routes.some(
          (route) => route.tls === null && route.host === host
        );
      return unanswered || unsure ? "unknown" : false;
    },
    [asked, front, fronting.routes, unanswered]
  );
}

/** Whether something in front terminates TLS, or `"unknown"` until it is read. */
export type FrontingTls = boolean | "unknown";
