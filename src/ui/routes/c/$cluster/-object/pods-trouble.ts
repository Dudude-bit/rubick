import { useMemo } from "react";

import { useAttention } from "@/hooks/useAttention";
import type { AttentionItem } from "@/lib/attention";
import type { Finding } from "@/lib/governance";
import { useClusterStore } from "@/stores/clusterStore";
import { problemOf, problemOfItems, type Problem } from "./problem";
import { itemsOfRow } from "./row-items";

/**
 * The shell's rows about a workload's pods that its list row carries, read
 * where the window's scope holds its namespace or else for that namespace
 * alone; `null` until that answer is in.
 */
export function usePodsTrouble(
  kind: string,
  namespace: string | undefined,
  name: string | undefined
): readonly AttentionItem[] | null {
  const windowScope = useClusterStore((s) => s.namespaceScope);
  const covered =
    !namespace || windowScope.length === 0 || windowScope.includes(namespace);
  const scope = useMemo(
    () => (covered || !namespace ? undefined : [namespace]),
    [covered, namespace]
  );
  const attention = useAttention({ scope, enabled: !!namespace && !!name });
  return useMemo(
    () =>
      attention && namespace && name
        ? itemsOfRow(attention.items, kind, namespace, name).filter(
            (item) => item.workload
          )
        : null,
    [attention, kind, namespace, name]
  );
}

/**
 * The header chip's problem where its pods have some: the page's own
 * findings and its pods' rows together, as its list row counts them.
 */
export function withPodsTrouble(
  findings: readonly Finding[],
  pods: readonly AttentionItem[] | null
): Problem | undefined {
  const theirs = pods && problemOfItems(pods);
  if (!theirs) return undefined;
  const own = problemOf(findings);
  if (!own) return theirs;
  const worst = own.tone === "err" || theirs.tone === "warn" ? own : theirs;
  return { tone: worst.tone, n: own.n + theirs.n, title: worst.title };
}
