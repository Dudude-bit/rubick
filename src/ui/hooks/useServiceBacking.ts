import { useMemo } from "react";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import type { NamespaceBacking } from "@/lib/ingress-health";
import type { Known } from "@/lib/known";
import { queryKeys } from "@/lib/query-keys";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { ServiceInfo, ServicePublished } from "@/generated/types";

interface Answer {
  /** `null` for the one cluster-wide read. */
  namespace: string | null;
  lists: NamespaceBacking | null;
  why: string | null;
}

async function readBacking(namespaces: string[] | null): Promise<Answer[]> {
  const reaches = namespaces && namespaces.length > 0 ? namespaces : [null];
  const settled = await Promise.allSettled(
    reaches.map((namespace) => commands.listServiceBacking(namespace))
  );
  return settled.map((answer, index) => ({
    namespace: reaches[index],
    lists: answer.status === "fulfilled" ? answer.value : null,
    why: answer.status === "rejected" ? errorToShow(answer.reason) : null,
  }));
}

export interface ServiceBackingRead {
  /** One namespace's Services and what each publishes, or why not. */
  in: (namespace: string) => Known<NamespaceBacking>;
  service: (namespace: string, name: string) => ServiceInfo | undefined;
  published: (namespace: string, name: string) => ServicePublished | undefined;
}

const key = (namespace: string, name: string) => `${namespace}/${name}`;

/**
 * What the Services in these namespaces publish, read once for the whole
 * scope (`null` is the cluster) and indexed, so a list draws every row's
 * verdict from one answer instead of one read per row.
 */
export function useServiceBacking(
  namespaces: string[] | null,
  enabled = true
): ServiceBackingRead {
  const read = useLiveQuery({
    queryKey: queryKeys.serviceBacking(namespaces),
    queryFn: () => readBacking(namespaces),
    enabled,
    refresh: "slow",
  });
  const { data, error } = read;

  return useMemo(() => {
    const services = new Map<string, ServiceInfo>();
    const published = new Map<string, ServicePublished>();
    const byNamespace = new Map<string, NamespaceBacking>();
    const homeOf = (namespace: string) => {
      let home = byNamespace.get(namespace);
      if (!home) {
        home = { services: [], published: [] };
        byNamespace.set(namespace, home);
      }
      return home;
    };
    for (const answer of data ?? []) {
      for (const service of answer.lists?.services ?? []) {
        services.set(key(service.namespace, service.name), service);
        homeOf(service.namespace).services.push(service);
      }
      for (const entry of answer.lists?.published ?? []) {
        const namespace = entry.service.namespace ?? "";
        published.set(key(namespace, entry.service.name), entry);
        homeOf(namespace).published.push(entry);
      }
    }
    const answerFor = (namespace: string) =>
      data?.find((answer) => answer.namespace === namespace) ??
      data?.find((answer) => answer.namespace === null);
    const none: NamespaceBacking = { services: [], published: [] };
    return {
      in: (namespace) => {
        const answer = answerFor(namespace);
        if (!answer) {
          return { known: false, why: error ? errorToShow(error) : null };
        }
        if (!answer.lists) return { known: false, why: answer.why };
        return { known: true, value: byNamespace.get(namespace) ?? none };
      },
      service: (namespace, name) => services.get(key(namespace, name)),
      published: (namespace, name) => published.get(key(namespace, name)),
    };
  }, [data, error]);
}
