/**
 * Caches the pod's labels through transient empty fetches and
 * exposes a `findReplacement` callback that searches for a running
 * sibling pod by app/component labels — used when the current pod
 * disappears (rolled, evicted, deleted) and the UI wants to switch
 * the user to the replacement seamlessly.
 *
 * Extracted from PodDetail.tsx.
 */

import { useCallback, useEffect, useState } from "react";

import { commands } from "@/lib/commands";
import type { PodInfo } from "@/generated/types";

/** What says which workload a pod is of. */
const WORKLOAD_LABEL_KEYS = [
  "app",
  "app.kubernetes.io/name",
  "app.kubernetes.io/instance",
  "component",
];
/** Which ReplicaSet of it: a rollout's new pods carry another. */
const REVISION_LABEL_KEY = "pod-template-hash";

/** The search answered with a pod, answered with none, or could not look. */
export type Replacement =
  | { is: "found"; pod: PodInfo }
  | { is: "none" }
  | { is: "unread"; error: unknown };

/**
 * The selector a replacement is looked for by, or `null` for a pod with no
 * label that says what it is of. The workload's labels alone where it has
 * any: the pod-template-hash names one ReplicaSet, and after a rollout,
 * which is how most pods go, every replacement is in another.
 */
export function replacementSelector(
  labels: Record<string, string>
): string | null {
  const of = (keys: string[]) =>
    keys.filter((key) => labels[key]).map((key) => `${key}=${labels[key]}`);
  const parts = of(WORKLOAD_LABEL_KEYS);
  const selector = (parts.length > 0 ? parts : of([REVISION_LABEL_KEY])).join(
    ","
  );
  return selector || null;
}

/**
 * The newest pod that runs, other than the one that went. The derived
 * status, not the phase: a crash-looping pod is in phase `Running` and is
 * the last thing to send someone to when the pod they were reading
 * disappeared.
 */
export function replacementAmong(
  pods: PodInfo[],
  gone: string | undefined
): PodInfo | null {
  const running = pods.filter(
    (pod) => pod.name !== gone && pod.status.display === "Running"
  );
  const born = (pod: PodInfo) => Date.parse(pod.createdAt ?? "") || 0;
  return running.sort((a, b) => born(b) - born(a))[0] ?? null;
}

export function usePodReplacementSearch(
  pod: PodInfo | undefined,
  podName: string | undefined,
  namespace: string | undefined
) {
  const [savedLabels, setSavedLabels] = useState<Record<string, string> | null>(
    null
  );
  const [isSearching, setIsSearching] = useState(false);

  // Cache last non-empty labels so a transient empty re-fetch (which
  // happens when the pod gets deleted) doesn't wipe the snapshot we
  // need to find a replacement.
  useEffect(() => {
    if (pod?.labels && Object.keys(pod.labels).length > 0) {
      // oxlint-disable-next-line react-hooks/set-state-in-effect
      setSavedLabels(pod.labels);
    }
  }, [pod?.labels]);

  const findReplacement = useCallback(
    async (labelsToUse?: Record<string, string>): Promise<Replacement> => {
      const labels = labelsToUse || savedLabels;
      const selector = labels && replacementSelector(labels);
      if (!selector || !namespace) return { is: "none" };

      setIsSearching(true);
      try {
        const pods = await commands.listPods({
          namespace,
          labelSelector: selector,
          fieldSelector: null,
          limit: null,
          statusFilter: null,
          selector: null,
          nodeName: null,
        });
        const pod = replacementAmong(pods, podName);
        return pod ? { is: "found", pod } : { is: "none" };
      } catch (error) {
        // A list that failed or was refused has not looked: "none" would
        // say every pod of the workload is down.
        return { is: "unread", error };
      } finally {
        setIsSearching(false);
      }
    },
    [savedLabels, namespace, podName]
  );

  return {
    savedLabels,
    isSearching,
    findReplacement,
  };
}
