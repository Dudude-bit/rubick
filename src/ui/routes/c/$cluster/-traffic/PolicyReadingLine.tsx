/**
 * Under a POLICY_DENIED drop Hubble named no policy for: what the app reads
 * of the NetworkPolicies over the two ends, said as its own reading, and
 * the other engines' policies it does not read.
 */
import { useQueries, useQuery } from "@tanstack/react-query";

import type { FlowEnd } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { commands } from "@/lib/commands";
import { knownOf, type Known } from "@/lib/known";
import { listPodRows } from "@/lib/pod-rows";
import type { LabeledNamespace } from "@/lib/policy-peers";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { STALE_TIMES } from "@/lib/refresh";
import {
  podsOfEnd,
  policyReading,
  rowsIn,
  type PolicyReading,
  type WorkloadPod,
} from "./policy-reading";
import { readingWords } from "./traffic-words";

type Read = PolicyReading & { others: Known<string[]> };

function useReading(
  from: FlowEnd & { is: "workload" },
  to: FlowEnd & { is: "workload" }
): Read | null {
  const homes = [...new Set([to.key.namespace, from.key.namespace])];
  const pods = useQueries({
    queries: homes.map((namespace) => ({
      queryKey: queryKeys.podRows(namespace),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listPodRows([namespace], signal),
      staleTime: STALE_TIMES.resourceList,
    })),
  });
  const policies = useQueries({
    queries: homes.map((namespace) => ({
      queryKey: queryKeys.resources(ResourceType.NetworkPolicy, namespace),
      queryFn: () => commands.listNetworkPoliciesIn([namespace]),
      staleTime: STALE_TIMES.resourceList,
    })),
  });
  const namespaces = useQuery({
    queryKey: queryKeys.namespaces(),
    queryFn: () => commands.listNamespaces(),
    staleTime: STALE_TIMES.slow,
  });
  const others = useQuery({
    queryKey: queryKeys.otherPolicyKinds(homes),
    queryFn: () => commands.listOtherPolicyKinds(homes),
    staleTime: STALE_TIMES.slow,
  });
  if ([...pods, ...policies, namespaces, others].some((q) => q.isPending))
    return null;
  const readPods = pods.map((q) => knownOf(q));
  const unreadPods = readPods.find((read) => !read.known);
  const all: WorkloadPod[] = readPods.flatMap((read) =>
    read.known ? (read.value.rows as WorkloadPod[]) : []
  );
  const policyOf = (namespace: string) =>
    rowsIn(knownOf(policies[homes.indexOf(namespace)]), namespace);
  const kinds = knownOf(others);
  const reading: PolicyReading =
    unreadPods && !unreadPods.known
      ? { says: "unread", why: unreadPods.why }
      : policyReading({
          from: podsOfEnd(from, all) ?? [],
          to: podsOfEnd(to, all) ?? [],
          toPolicies: policyOf(to.key.namespace),
          fromPolicies: policyOf(from.key.namespace),
          namespaces: knownOf(namespaces) as Known<LabeledNamespace[]>,
        });
  return {
    ...reading,
    others: kinds.known
      ? {
          known: true,
          value: [...new Set(kinds.value.flatMap((entry) => entry.kinds))],
        }
      : kinds,
  };
}

function Reading({
  from,
  to,
}: {
  from: FlowEnd & { is: "workload" };
  to: FlowEnd & { is: "workload" };
}) {
  const t = useT();
  const read = useReading(from, to);
  if (!read) return null;
  return (
    <p className="text-[11px] text-fg-mut" data-testid="policy-reading">
      {readingWords(read, read.others, from.key, to.key, t).join(" ")}
    </p>
  );
}

/** Nothing for an end that is no workload: no pods to read policies over. */
export function PolicyReadingLine({
  from,
  to,
}: {
  from: FlowEnd;
  to: FlowEnd;
}) {
  if (from.is !== "workload" || to.is !== "workload") return null;
  return <Reading from={from} to={to} />;
}
