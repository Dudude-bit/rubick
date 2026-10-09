import { useEffect, useRef } from "react";
import {
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useHeldRead } from "@/hooks/useHeldRead";
import { useReadThereAt } from "@/hooks/useReadUid";

type Pod = { status: { ready: boolean; display: string } };

const NONE: never[] = [];

const readyIn = (pods: readonly Pod[]) =>
  pods.filter((pod) => pod.status.ready && pod.status.display !== "Terminating")
    .length;

/**
 * A workload page's own pods as every reader on it draws them: a NotFound
 * beside the workload the page holds is still reading, and the Replicas bar
 * is split by them only where they can speak beside the header. A read taken
 * before the page's read of the workload that counts another number ready
 * than its controller (`counted`) cannot, and is asked again: Sam's big-pull
 * page said Ready in its header over a bar still "1 starting".
 */
export function useWorkloadPods<P extends Pod>(
  kind: string,
  namespace: string | null | undefined,
  name: string | undefined,
  query: Pick<
    UseQueryResult<P[]>,
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
  const client = useQueryClient();
  const read = useHeldRead(kind, namespace, name, query, key);
  const held = useReadThereAt(kind, namespace, name);
  const pods: P[] = read.data ?? NONE;
  const unread = !!read.error || read.isPending || read.data === undefined;
  const at = query.dataUpdatedAt;
  const behind =
    !unread && counted !== undefined && at < held && readyIn(pods) !== counted;
  const asked = useRef(0);
  useEffect(() => {
    if (!behind || asked.current === at) return;
    asked.current = at;
    void client.invalidateQueries({ queryKey: key, exact: true });
  });
  return {
    pods,
    error: read.error,
    isPending: read.isPending,
    refetch: read.refetch,
    /** What the Replicas bar splits by, or null where it is the controller's alone. */
    split: unread || behind ? null : pods,
  };
}
