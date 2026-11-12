import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";

import { ClusterFrontDoor } from "./ClusterFrontDoor";
import { clusterLink, hrefOf } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";

/**
 * The route a restored tab is waiting on, the cluster the window was last
 * in, or the door to pick one.
 */
export function FrontDoorRoute() {
  const known = useClusterStore((s) => s.contextsKnown);
  const last = useClusterStore((s) =>
    s.lastContext && s.contexts.some((c) => c.name === s.lastContext)
      ? s.lastContext
      : null
  );
  // The bridge that delivers a tab's route is mounted with the shell, and
  // there is none here. Sent to the last cluster first, the window connected
  // it and only then went where the tab was: a sign-in for a cluster the
  // tab is not in, and one that kept running under a tab whose own cluster
  // the kubeconfig had lost.
  const restored = useScopeTabStore((s) =>
    s.pendingHref !== null && s.pendingHref !== "/" ? s.pendingHref : null
  );
  // Nowhere before the kubeconfig is read: one that cannot be read is said
  // here, beside the file it was read from and the way to change it.
  const target = known
    ? (restored ?? (last ? hrefOf(clusterLink(last)) : null))
    : null;
  const navigate = useNavigate();
  useEffect(() => {
    if (target) void navigate({ href: target, replace: true });
  }, [target, navigate]);
  if (target) return null;
  return (
    <div className="h-screen overflow-auto bg-canvas text-fg-mid">
      <ClusterFrontDoor />
    </div>
  );
}
