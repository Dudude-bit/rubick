import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { PersistentVolumeClaimInfo } from "@/generated/types";
import {
  claimCause,
  type ClaimCause,
  type ClassesRead,
} from "@/lib/claim-cause";
import { commands } from "@/lib/commands";
import { whole } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** The cluster's StorageClasses under the key and in the shape their own list keeps, so a claim's readers and that list share one answer. */
export function useStorageClasses(enabled: boolean): ClassesRead {
  const isConnected = useClusterStore((s) => s.isConnected);
  const classes = useLiveQuery({
    queryKey: queryKeys.resources(ResourceType.StorageClass, null),
    queryFn: () => commands.listStorageClasses(null).then(whole),
    enabled: enabled && isConnected,
    refresh: "steady",
  });
  if (classes.data) return classes.data.rows;
  return classes.error ? "unread" : "reading";
}

/** Why a claim is Pending, reading the StorageClasses only while it is. */
export function useClaimCause(
  claim: PersistentVolumeClaimInfo | undefined
): ClaimCause | null {
  const classes = useStorageClasses(claim?.status === "Pending");
  return claim ? claimCause(claim, classes) : null;
}
