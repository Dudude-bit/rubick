import { useMemo } from "react";
import { useQueries, type UseQueryResult } from "@tanstack/react-query";

import type {
  IngressClassBinding,
  IngressInfo,
  TlsCertificate,
} from "@/generated/types";
import type { ServiceHealthRead } from "@/hooks/useServiceHealthInputs";
import { certificatesOf } from "@/hooks/useTlsCertificates";
import { commands } from "@/lib/commands";
import {
  ingressHealthOf,
  secretNamesOf,
  type IngressHealth,
} from "@/lib/ingress-health";
import { knownOf } from "@/lib/known";
import { queryKeys } from "@/lib/query-keys";

type Answer<V> = Pick<UseQueryResult<V>, "data" | "error">;

const answers = <V>(results: UseQueryResult<V>[]): Answer<V>[] =>
  results.map(({ data, error }) => ({ data, error }));

/**
 * Each Ingress's verdict, from reads made once for every row: the class
 * bindings, the scope's Services, each namespace's TLS Secrets. The Ingresses
 * list and the Overview both read it, so the two cannot disagree. The
 * Services come from the caller, who already reads them for the same scope.
 */
export function useIngressHealth(
  rows: readonly IngressInfo[] | undefined,
  backing: ServiceHealthRead,
  enabled = true
): (ingress: IngressInfo) => IngressHealth {
  const classes = useMemo(
    () => [...new Set((rows ?? []).map((ingress) => ingress.className))],
    [rows]
  );
  const bindings = useQueries({
    queries: classes.map((className) => ({
      queryKey: queryKeys.ingressClass(className),
      queryFn: () => commands.resolveIngressClass(className ?? null),
      enabled,
    })),
    combine: answers<IngressClassBinding>,
  });
  const secrets = useMemo(() => {
    const byNamespace = new Map<string, Set<string>>();
    for (const ingress of rows ?? []) {
      for (const name of secretNamesOf(ingress)) {
        const names = byNamespace.get(ingress.namespace) ?? new Set();
        byNamespace.set(ingress.namespace, names.add(name));
      }
    }
    return [...byNamespace].map(([namespace, names]) => ({
      namespace,
      names: [...names].sort(),
    }));
  }, [rows]);
  const certificates = useQueries({
    queries: secrets.map(({ namespace, names }) => ({
      queryKey: queryKeys.tlsCertificates(namespace, names),
      queryFn: async () =>
        new Map(
          (await commands.getTlsCertificates(namespace, names)).map(
            (entry) => [entry.secretName, entry] as const
          )
        ),
      enabled,
    })),
    combine: answers<Map<string, TlsCertificate>>,
  });

  return useMemo(
    () => (ingress: IngressInfo) => {
      const binding = bindings[classes.indexOf(ingress.className)];
      const at = secrets.findIndex(
        (entry) => entry.namespace === ingress.namespace
      );
      const read = certificates[at];
      return ingressHealthOf({
        ingress,
        binding: binding ? knownOf(binding) : { known: false, why: null },
        backing: backing.in(ingress.namespace),
        certificates: read
          ? certificatesOf(read.data, read.error, secrets[at].names)
          : undefined,
      });
    },
    [bindings, classes, backing, secrets, certificates]
  );
}
