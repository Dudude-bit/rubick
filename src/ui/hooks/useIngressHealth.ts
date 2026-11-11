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
import { useDoorAsk } from "@/hooks/useDoorAsk";
import { useClasslessTakers } from "@/integrations";
import { useIngressTls } from "@/hooks/useIngressTls";
import { certificatesOf, useTlsCertificates } from "@/hooks/useTlsCertificates";
import { commands } from "@/lib/commands";
import {
  ingressHealthOf,
  secretNamesOf,
  type IngressHealth,
  type IngressInputs,
} from "@/lib/ingress-health";
import { hostTls } from "@/lib/ingress-tls";
import { knownOf } from "@/lib/known";
import { queryKeys } from "@/lib/query-keys";

const NO_ROWS: readonly IngressHealthInput[] = [];

type Answer<V> = Pick<UseQueryResult<V>, "data" | "error">;

const answers = <V>(results: UseQueryResult<V>[]): Answer<V>[] =>
  results.map(({ data, error }) => ({ data, error }));

type Ingress = Pick<IngressHealthInput, "namespace" | "name" | "rules">;

const hostKey = (ingress: Pick<Ingress, "namespace" | "name">, host: string) =>
  `${ingress.namespace}/${ingress.name}/${host}`;

/**
 * Whether its controller serves a host as plain HTTP whatever `spec.tls`
 * says, asked with the same hosts as the Ingress TLS column so the answer is
 * one cached read. `null` where nobody could say.
 *
 * With `asks` off no controller is asked anything: a supplier costs a
 * request per Ingress, or the whole cluster's list, which a count kept on
 * every screen cannot pay. What a caller that asks was already told is read
 * from the cache; without it the answer is `null` wherever a controller here
 * could have said plain, and `false` where none could.
 *
 * Kept as a string until it changes, so a verdict built on it does not churn
 * with every render of the answers.
 */
export function usePlainHosts(ingresses: readonly Ingress[], asks = true) {
  const asked = useMemo(
    () =>
      ingresses.map((ingress) => ({
        namespace: ingress.namespace,
        name: ingress.name,
        hosts: ingress.rules.flatMap((rule) => (rule.host ? [rule.host] : [])),
      })),
    [ingresses]
  );
  const answers = useIngressTls(asked, asks);
  const { unread } = answers;
  // No supplier here, nothing to say of any host: the shell renders often.
  const said = (answers.available ? asked : [])
    .flatMap(({ hosts, ...ingress }) =>
      hosts.flatMap((host) => {
        const tls = hostTls(true, answers.of(ingress, host), unread);
        return tls === true
          ? []
          : [
              `${tls === false ? "plain" : "unknown"} ${hostKey(ingress, host)}`,
            ];
      })
    )
    .join("\n");
  return useMemo(() => {
    const lines = new Set(said.split("\n"));
    return (ingress: Pick<Ingress, "namespace" | "name">, host: string) => {
      const key = hostKey(ingress, host);
      if (lines.has(`plain ${key}`)) return true;
      return lines.has(`unknown ${key}`) ? null : false;
    };
  }, [said]);
}

/**
 * Each Ingress's verdict, from reads made once for every row: the class
 * bindings, the scope's Services, each namespace's TLS Secrets. The Ingresses
 * list and the Overview both read it. The Services come from the caller, who
 * already reads them for the same scope.
 *
 * Only a caller that says `asksControllers` has each Ingress's controller
 * asked about its hosts; the count on every screen does not, and reads a
 * verdict that needed that answer as not checked.
 */
export function useIngressHealth(
  rows: readonly IngressHealthInput[] | undefined,
  backing: ServiceHealthRead,
  { enabled = true, asksControllers = false } = {}
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
  const plain = usePlainHosts(rows ?? NO_ROWS, asksControllers);
  const door = useDoorAsk(enabled);
  const classless = useClasslessTakers();

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
        servedPlain: (host) => plain(ingress, host),
        door,
        classless,
      });
    },
    [bindings, classes, backing, secrets, certificates, plain, door, classless]
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
  const plain = usePlainHosts(
    useMemo(() => (ingress ? [ingress] : []), [ingress])
  );
  const door = useDoorAsk(!!ingress);
  const classless = useClasslessTakers();
  if (!ingress) return undefined;
  return ingressHealthOf({
    ingress,
    binding: knownOf(binding),
    backing: backing.in(ingress.namespace),
    certificates,
    servedPlain: (host) => plain(ingress, host),
    door,
    classless,
  });
}
