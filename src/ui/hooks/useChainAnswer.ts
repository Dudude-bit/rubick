import { skipToken, useQueries, type QueryKey } from "@tanstack/react-query";

import type { Scoped, ServicePublished } from "@/generated/types";
import { useConnections, useConnectionsKey } from "@/hooks/useConnections";
import { useHeldAnswer, type HeldAnswer } from "@/hooks/useHeldAnswer";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import type { SeenOf, ServiceSeen } from "@/lib/service-health";

/** A Service an answer stops at or publishes through, as the watches under it are keyed. */
export interface ChainService {
  namespace: string;
  name: string;
  selector: string | null;
}

const idOf = (namespace: string, name: string) => `${namespace}/${name}`;

/** The Services an answer reads what each publishes of, each once, in a stable order. */
export function chainServices(
  published: readonly Pick<ServicePublished, "service">[] | undefined,
  selectorOf: (namespace: string, name: string) => string | null = () => null
): ChainService[] {
  const found = new Map<string, ChainService>();
  for (const { service } of published ?? []) {
    if (service.kind !== ResourceType.Service) continue;
    const namespace = service.namespace ?? "";
    const facts = service.facts;
    found.set(idOf(namespace, service.name), {
      namespace,
      name: service.name,
      selector:
        facts?.kind === "service"
          ? facts.selector
          : selectorOf(namespace, service.name),
    });
  }
  return [...found.values()].sort((a, b) =>
    idOf(a.namespace, a.name) < idOf(b.namespace, b.name) ? -1 : 1
  );
}

/**
 * What the watches under each Service have seen, from the entries
 * `ChainWatches` keeps. `followed` says they are mounted on this surface: a
 * pod watch that has not listed yet is then one still listing, and otherwise
 * one nobody runs.
 */
export function useServicesSeen(
  services: readonly ChainService[],
  followed: boolean
): SeenOf {
  const answers = useQueries({
    queries: services.flatMap((service) => [
      {
        queryKey: queryKeys.serviceWatch(
          "pods",
          service.namespace,
          service.name,
          service.selector
        ),
        queryFn: skipToken,
      },
      {
        queryKey: queryKeys.serviceWatch(
          "changed",
          service.namespace,
          service.name
        ),
        queryFn: skipToken,
      },
    ]),
  });
  const seen = new Map<string, ServiceSeen>();
  services.forEach((service, index) => {
    const pods = answers[index * 2];
    const listed = (pods?.data as Scoped<unknown> | undefined)?.rows.length;
    seen.set(idOf(service.namespace, service.name), {
      pods: !service.selector
        ? undefined
        : listed !== undefined
          ? { pods: listed, at: pods.dataUpdatedAt }
          : followed
            ? "listing"
            : undefined,
      changed: (answers[index * 2 + 1]?.data as number | undefined) ?? 0,
    });
  });
  return (service) => seen.get(idOf(service.namespace ?? "", service.name));
}

export interface ChainAnswer extends HeldAnswer {
  /** The Services its chain reaches, for `ChainWatches` to follow. */
  services: ChainService[];
  /** Where the answer is cached, which a change under one of them reads again. */
  key: QueryKey;
}

/**
 * The neighbourhood of a workload, a pod or an Ingress as every reader of its
 * traffic chain draws it, held to what the watches `ChainWatches` keeps under
 * each Service it reaches have seen, as a Service's own page holds its answer.
 * Sam's big-pull Deployment page drew red "No pod carries app=big-pull" for
 * eight seconds beside a header reading Ready 1/1, from a read nothing asked
 * again until a poll.
 */
export function useChainAnswer(
  kind: string,
  name: string | undefined,
  namespace: string | null | undefined,
  {
    enabled = true,
    followed = true,
  }: { enabled?: boolean; followed?: boolean } = {}
): ChainAnswer {
  const query = useConnections(kind, name, namespace, enabled);
  const key = useConnectionsKey(kind, name, namespace);
  const services = chainServices(query.data?.published);
  const seen = useServicesSeen(services, followed);
  const held = useHeldAnswer(kind, name, namespace, query, key, seen, followed);
  return { ...held, services, key };
}
