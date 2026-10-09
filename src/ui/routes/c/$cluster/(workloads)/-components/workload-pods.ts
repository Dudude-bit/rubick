import type { QueryKey, UseQueryResult } from "@tanstack/react-query";

import { useHeldOwner, useHeldRead, useReadBehind } from "@/hooks/useHeldRead";

type Pod = { status: { ready: boolean; display: string } };

/** Pods read with the uid of the object they were read for. */
type Owned<P> = { uid: string; pods: P[] };

const NONE: never[] = [];

const readyIn = (pods: readonly Pod[]) =>
  pods.filter((pod) => pod.status.ready && pod.status.display !== "Terminating")
    .length;

/**
 * A workload page's own pods as every reader on it draws them: a NotFound
 * beside the workload the page holds is still reading, and so are pods read
 * for another object of its name (see {@link useHeldOwner}), and the Replicas bar
 * is split by them only where they can speak beside the header. A read taken
 * before the page's read of the workload that counts another number ready
 * than its controller (`counted`) cannot, and is asked again: Sam's big-pull
 * page said Ready in its header over a bar still "1 starting". Where it
 * found none of them it is still reading, not "Pods 0".
 */
export function useWorkloadPods<P extends Pod>(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  query: Pick<
    UseQueryResult<P[] | Owned<P>>,
    | "data"
    | "dataUpdatedAt"
    | "error"
    | "errorUpdatedAt"
    | "isPending"
    | "refetch"
  >,
  key: QueryKey,
  counted: number | undefined
) {
  const read = useHeldRead(kind, namespace, name, query, key);
  const { data } = read;
  const other = useHeldOwner(
    kind,
    namespace,
    name,
    {
      answeredFor: Array.isArray(data) ? undefined : data?.uid,
      at: query.dataUpdatedAt,
    },
    key
  );
  const listed = other ? undefined : Array.isArray(data) ? data : data?.pods;
  const pods: P[] = listed ?? NONE;
  const unread = !!read.error || read.isPending || other || !listed;
  const behind = useReadBehind(
    kind,
    namespace,
    name,
    {
      at: query.dataUpdatedAt,
      contradicted:
        !unread && counted !== undefined && readyIn(pods) !== counted,
    },
    key
  );
  return {
    pods,
    error: read.error,
    isPending: read.isPending || other || (behind && pods.length === 0),
    refetch: read.refetch,
    /** What the Replicas bar splits by, or null where it is the controller's alone. */
    split: unread || behind ? null : pods,
  };
}
