import { useMemo } from "react";

import { commands } from "@/lib/commands";
import { errorToShow } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { ServiceBacking, ServicePublished } from "@/generated/types";

interface Answer {
  /** `null` for the one cluster-wide read. */
  namespace: string | null;
  lists: ServiceBacking | null;
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
  /** What one Service publishes, whole, once its namespace has answered. */
  published: (namespace: string, name: string) => ServicePublished | undefined;
  /** Why one namespace was not read: `null` once it was, or while it is. */
  why: (namespace: string) => string | null;
}

const key = (namespace: string, name: string) => `${namespace}/${name}`;

/**
 * What the Services in these namespaces publish, whole, read once for the
 * whole scope (`null` is the cluster) and indexed, so a list draws every
 * row's verdict from one answer instead of one read per row.
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
    const published = new Map<string, ServicePublished>();
    for (const answer of data ?? []) {
      for (const entry of answer.lists?.published ?? []) {
        published.set(
          key(entry.service.namespace ?? "", entry.service.name),
          entry
        );
      }
    }
    const answerFor = (namespace: string) =>
      data?.find((answer) => answer.namespace === namespace) ??
      data?.find((answer) => answer.namespace === null);
    return {
      published: (namespace, name) => published.get(key(namespace, name)),
      why: (namespace) => {
        const answer = answerFor(namespace);
        if (!answer) return error ? errorToShow(error) : null;
        return answer.why;
      },
    };
  }, [data, error]);
}
