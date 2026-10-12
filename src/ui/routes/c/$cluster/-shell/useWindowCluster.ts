import { clusterColor } from "@/lib/cluster-identity";
import { useClusterMark } from "@/stores/clusterIdentityStore";
import { hasSession, useClusterStore } from "@/stores/clusterStore";

/**
 * The window's cluster, its colour and whether its session is up, as every
 * part of the shell that paints them reads it. Each such element carries
 * `data-window-cluster`, which `index.css` keeps out of the colour fade.
 */
export function useWindowCluster(): {
  context: string | null;
  color: string;
  live: boolean;
} {
  const context = useClusterStore((s) => s.currentContext);
  const live = useClusterStore(hasSession);
  const { hue } = useClusterMark(context);
  return { context, color: clusterColor(context, hue), live };
}
