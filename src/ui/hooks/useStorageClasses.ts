import { useMemo } from "react";

import { useLiveQuery } from "@/hooks/useLiveQuery";
import type { PersistentVolumeClaimInfo } from "@/generated/types";
import {
  claimCause,
  claimNeeds,
  type ClaimCause,
  type ClaimReads,
  type ClassesRead,
  type VolumesRead,
} from "@/lib/claim-cause";
import { commands } from "@/lib/commands";
import { whole } from "@/lib/namespace-scope";
import { queryKeys } from "@/lib/query-keys";
import { ResourceType } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";

/** The cluster's StorageClasses under the key and in the shape their own list keeps, so a claim's readers and that list share one answer. */
function useStorageClasses(enabled: boolean): ClassesRead {
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

/** The cluster's PersistentVolumes, likewise under their own list's key. */
function usePersistentVolumes(enabled: boolean): VolumesRead {
  const isConnected = useClusterStore((s) => s.isConnected);
  const volumes = useLiveQuery({
    queryKey: queryKeys.resources(ResourceType.PersistentVolume, null),
    queryFn: () => commands.listPersistentVolumes(null).then(whole),
    enabled: enabled && isConnected,
    refresh: "steady",
  });
  if (volumes.data) return volumes.data.rows;
  return volumes.error ? "unread" : "reading";
}

/** What explains a Pending claim, each read only while some claim needs it. */
export function useClaimReads(
  needs: ReturnType<typeof claimNeeds>
): ClaimReads {
  const classes = useStorageClasses(needs.classes);
  const volumes = usePersistentVolumes(needs.volumes);
  return useMemo(() => ({ classes, volumes }), [classes, volumes]);
}

/** Why a claim is Pending, reading what explains it only while it is. */
export function useClaimCause(
  claim: PersistentVolumeClaimInfo | undefined
): ClaimCause | null {
  const reads = useClaimReads(claimNeeds(claim ? [claim] : []));
  return claim ? claimCause(claim, reads) : null;
}
