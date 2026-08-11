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

const REPLACEMENT_LABEL_KEYS = [
  "app",
  "app.kubernetes.io/name",
  "app.kubernetes.io/instance",
  "component",
  "pod-template-hash",
];

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSavedLabels(pod.labels);
    }
  }, [pod?.labels]);

  const findReplacement = useCallback(
    async (labelsToUse?: Record<string, string>): Promise<PodInfo | null> => {
      const labels = labelsToUse || savedLabels;
      if (!labels || !namespace) return null;

      setIsSearching(true);
      try {
        const labelParts: string[] = [];
        for (const key of REPLACEMENT_LABEL_KEYS) {
          if (labels[key]) {
            labelParts.push(`${key}=${labels[key]}`);
          }
        }
        if (labelParts.length === 0) return null;

        const pods = await commands.listPods({
          namespace,
          labelSelector: labelParts.join(","),
          fieldSelector: null,
          limit: null,
          statusFilter: null,
          selector: null,
          nodeName: null,
        });

        // The derived status, not the phase: a crash-looping pod is in
        // phase `Running` and is the last thing to send someone to when
        // the pod they were reading disappeared.
        return (
          pods.find(
            (p) => p.name !== podName && p.status.display === "Running"
          ) ?? null
        );
      } catch (err) {
        console.error("Failed to find replacement pod:", err);
        return null;
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
