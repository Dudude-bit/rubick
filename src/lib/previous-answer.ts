/**
 * Keep a query's previous answer only while it is an answer about the same
 * cluster.
 *
 * `placeholderData: keepPreviousData` exists so a narrower question does not
 * flicker through a skeleton. A context switch is not a narrower question: it
 * is a different cluster, under a key that says so, and the previous answer
 * then becomes one cluster's numbers drawn beside another cluster's name —
 * for as long as the new cluster takes to answer, which on a cluster that
 * refuses the read is for ever.
 *
 * Both callers key their query as `[name, context, …]`, which is the position
 * this reads.
 */
export function ofSameCluster<TData>(context: string | null) {
  return (
    previous: TData | undefined,
    previousQuery?: { queryKey: readonly unknown[] }
  ): TData | undefined =>
    previousQuery !== undefined && previousQuery.queryKey[1] === context
      ? previous
      : undefined;
}
