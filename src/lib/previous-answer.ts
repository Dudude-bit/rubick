/**
 * Keep a query's previous answer only while it is an answer about the same
 * cluster.
 *
 * `keepPreviousData` exists so a narrower question does not flicker through a
 * skeleton. A context switch is not a narrower question: the previous answer
 * becomes one cluster's numbers beside another cluster's name, and on a
 * cluster that refuses the read it stays there. Both callers key their query
 * as `[name, context, …]`, which is the position this reads.
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
