/**
 * Narrowing the cluster list down to the one you meant.
 *
 * A kubeconfig accretes contexts and never sheds them. Recency gets the two
 * clusters anybody opens to the top, but it cannot help someone who knows the
 * name and is looking at three hundred rows.
 *
 * The state lives in a hook rather than in `ClusterList` because the count
 * beside the heading and the rows in the list are the same fact, and a screen
 * that says "42 contexts" above three rows is the bug this app exists to not
 * have. One owner, one answer, both readers fed from it.
 *
 * @module hooks/useClusterFilter
 */

import { useDeferredValue, useMemo, useRef, useState } from "react";

import { filterContexts } from "@/lib/cluster-search";
import {
  aliasOf,
  useClusterIdentityStore,
} from "@/stores/clusterIdentityStore";
import { useClusterStore } from "@/stores/clusterStore";
import type { ContextInfo } from "@/generated/types";

export interface ClusterFilter {
  /** What is in the box, live — a deferred value would drop keystrokes. */
  filter: string;
  setFilter: (next: string) => void;
  /** The contexts that matched, in the order the store listed them. */
  shown: ContextInfo[];
  /** How many there are in total, whatever the filter says. */
  total: number;
  /** The needle `shown` was actually computed from. */
  query: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function useClusterFilter(): ClusterFilter {
  const contexts = useClusterStore((s) => s.contexts);
  const marks = useClusterIdentityStore((s) => s.marks);
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Deferred rather than debounced: a debounce is for a call that leaves the
  // window, and this one never does. React keeps the caret responsive and
  // lets the list land a frame late instead.
  const query = useDeferredValue(filter);

  const shown = useMemo(
    () => filterContexts(query, contexts, (context) => aliasOf(marks, context)),
    [query, contexts, marks]
  );

  return {
    filter,
    setFilter,
    shown,
    total: contexts.length,
    // The needle the rows were filtered by, not the one being typed — the
    // "nothing matches" sentence must never name a query the list has not
    // caught up with.
    query,
    inputRef,
  };
}
