import { useCallback, useMemo } from "react";

import type { ResourceConnections } from "@/generated/types";
import { hostTls, type RouteTls } from "@/lib/ingress-tls";
import { useIngressTls, type IngressRef } from "./useIngressTls";

/**
 * Whether each Ingress host on a route edge is served over TLS, as the
 * Ingress pages say it. The edge's own `tls` is `spec.tls` alone, which read
 * an ALB certificate named in an annotation as plain HTTP, and a Traefik
 * router that only loads a certificate as HTTPS.
 */
export function useRouteTls(conns: ResourceConnections | undefined): RouteTls {
  const asked = useMemo(() => {
    const byIngress = new Map<string, IngressRef>();
    for (const edge of conns?.edges ?? []) {
      const { from, relation } = edge;
      if (relation.verb !== "routes" || from.kind !== "Ingress") continue;
      if (!relation.host) continue;
      const key = `${from.namespace}/${from.name}`;
      const at = byIngress.get(key) ?? {
        namespace: from.namespace ?? "",
        name: from.name,
        hosts: [],
      };
      at.hosts.push(relation.host);
      byIngress.set(key, at);
    }
    return [...byIngress.values()];
  }, [conns]);
  const answers = useIngressTls(asked);
  const unread = answers.isPending || answers.error !== null;
  const { of } = answers;
  return useCallback(
    (ingress, host, spec) =>
      hostTls(
        spec,
        of({ namespace: ingress.namespace ?? "", name: ingress.name }, host),
        unread
      ),
    [of, unread]
  );
}
