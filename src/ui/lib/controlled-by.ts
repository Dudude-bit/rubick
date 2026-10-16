import type { PodInfo } from "@/generated/types";

/**
 * The pods a StatefulSet, DaemonSet or Job controls, by its uid: one made
 * again under its name does not inherit the pods of the one deleted before
 * it, which carry its labels and its pod names. All of them while its uid is
 * not read yet.
 */
export function controlledBy<P extends Pick<PodInfo, "ownerReferences">>(
  pods: P[],
  uid: string | undefined
): P[] {
  if (!uid) return pods;
  return pods.filter((pod) =>
    pod.ownerReferences.some((owner) => owner.controller && owner.uid === uid)
  );
}
