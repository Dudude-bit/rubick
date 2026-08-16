/**
 * Whether these Ingresses' hosts are served over TLS, including where the
 * certificate is nowhere near `spec.tls`.
 *
 * The core answer is the caller's and comes first: an Ingress that names a
 * Secret for a host is served over TLS, full stop, and this hook is never
 * consulted about it. What it adds is the case all three managed clouds are
 * in — a certificate held by the load balancer and named in an annotation —
 * which read as plain HTTP on every core surface in the app, links included.
 *
 * A list rather than one Ingress, because the widest of those surfaces is a
 * table: the Ingress list is where somebody clicks the URL, and a capability
 * asked once per row would have had to be left out of exactly the place the
 * wrong answer costs the most.
 *
 * `false` from a vendor is an answer, not a shrug: a controller that owns the
 * Ingress and finds no certificate for the host is saying it serves plain
 * HTTP. A host it says nothing about keeps whatever `spec.tls` decided.
 */

import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { useCapabilities, type IngressTls } from "@/integrations";

export interface IngressRef {
  namespace: string;
  name: string;
  hosts: string[];
}

export interface IngressTlsAnswers {
  /** Whether anything in this cluster could be asked at all. */
  available: boolean;
  /** `null` where no supplier spoke for that Ingress and host. */
  of: (
    ingress: { namespace: string; name: string },
    host: string
  ) => IngressTls | null;
  isPending: boolean;
  error: Error | null;
}

const key = (namespace: string, name: string) => `${namespace}/${name}`;

export function useIngressTls(ingresses: IngressRef[]): IngressTlsAnswers {
  const suppliers = useCapabilities("ingress.tls");

  // The identity of the array churns on every render of every caller that
  // builds it inline, and a query key that churned with it would refetch for
  // ever. The digest is what the answer actually depends on.
  const { wanted, digest } = useMemo(() => {
    const unique = new Map<string, IngressRef>();
    for (const ingress of ingresses) {
      const at = key(ingress.namespace, ingress.name);
      const seen = unique.get(at);
      const hosts = [...new Set([...(seen?.hosts ?? []), ...ingress.hosts])];
      unique.set(at, { ...ingress, hosts: hosts.sort() });
    }
    const list = [...unique.values()].sort((left, right) =>
      key(left.namespace, left.name).localeCompare(
        key(right.namespace, right.name)
      )
    );
    return {
      wanted: list,
      digest: list
        .map(
          (entry) =>
            `${key(entry.namespace, entry.name)}:${entry.hosts.join("|")}`
        )
        .join(","),
    };
  }, [ingresses]);

  const enabled = suppliers.length > 0 && wanted.length > 0;

  const results = useQueries({
    queries: suppliers.map((ask, index) => ({
      queryKey: ["ingress-tls", index, digest],
      queryFn: () => ask(wanted),
      enabled,
      // An annotation changes with a deploy, not by the second — the same
      // minute every routing read in the app uses.
      staleTime: 60_000,
    })),
  });

  const byIngress = new Map<string, IngressTls[]>();
  for (const result of results) {
    if (!result.data) continue;
    result.data.forEach((answers, position) => {
      const at = wanted[position];
      if (!at) return;
      const found = byIngress.get(key(at.namespace, at.name)) ?? [];
      found.push(...answers);
      byIngress.set(key(at.namespace, at.name), found);
    });
  }

  return {
    available: suppliers.length > 0,
    of: (ingress, host) => {
      const answers = (
        byIngress.get(key(ingress.namespace, ingress.name)) ?? []
      )
        .filter((answer) => answer.host === host)
        // A vendor saying it *is* terminated wins over one saying it is not:
        // two controllers both claiming an Ingress is already a
        // misconfiguration, and of the two answers the encrypted one is the
        // one a client can actually get.
        .sort(
          (left, right) => Number(right.terminated) - Number(left.terminated)
        );
      return answers[0] ?? null;
    },
    isPending: enabled && results.some((result) => result.isPending),
    error: (results.find((result) => result.error)?.error as Error) ?? null,
  };
}
