import { useCallback } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";

import { clusterOf, retargetHref } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";

/**
 * Go to a cluster: the address changes and the route connects. Asked for the
 * cluster the window is already in, it is a retry, and only connects.
 */
export function useOpenCluster(): (cluster: string) => void {
  const navigate = useNavigate();
  const router = useRouter();
  return useCallback(
    (cluster: string) => {
      const { pathname, searchStr } = router.state.location;
      if (clusterOf(pathname) === cluster) {
        void useClusterStore.getState().connect(cluster);
        return;
      }
      void navigate({ href: retargetHref(`${pathname}${searchStr}`, cluster) });
    },
    [navigate, router]
  );
}
