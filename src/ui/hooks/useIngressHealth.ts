import { useMemo } from "react";
import {
  useQueries,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";

import type {
  IngressClassBinding,
  IngressHealthInput,
  TlsCertificate,
} from "@/generated/types";
import {
  useServiceHealthInputs,
  type ServiceHealthRead,
} from "@/hooks/useServiceHealthInputs";
import { certificatesOf, useTlsCertificates } from "@/hooks/useTlsCertificates";
import { commands } from "@/lib/commands";
import {
  ingressHealthOf,
  secretNamesOf,
  type IngressHealth,
  type IngressInputs,
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
  rows: readonly IngressHealthInput[] | undefined,
  backing: ServiceHealthRead,
  enabled = true
): (ingress: IngressHealthInput) => IngressHealth {
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
    () => (ingress: IngressHealthInput) => {
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

/**
 * One Ingress's verdict, for its page, its peek and its Access tab: the same
 * reads as the list, made for the one object.
 */
export function useOneIngressHealth(
  ingress: IngressInputs["ingress"] | undefined
): IngressHealth | undefined {
  const binding = useQuery({
    queryKey: queryKeys.ingressClass(ingress?.className),
    queryFn: () => commands.resolveIngressClass(ingress?.className ?? null),
    enabled: !!ingress,
  });
  const backing = useServiceHealthInputs(ingress ? [ingress.namespace] : [], {
    enabled: !!ingress,
  });
  const certificates = useTlsCertificates(
    ingress?.namespace,
    ingress ? secretNamesOf(ingress) : []
  );
  if (!ingress) return undefined;
  return ingressHealthOf({
    ingress,
    binding: knownOf(binding),
    backing: backing.in(ingress.namespace),
    certificates,
  });
}
