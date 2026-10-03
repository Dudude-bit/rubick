import { createFileRoute, Navigate } from "@tanstack/react-router";

import { ClusterFrontDoor } from "@/components/cluster/ClusterFrontDoor";
import { clusterLink } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";

export const Route = createFileRoute("/")({
  component: FrontDoorRoute,
});

/** The cluster the window was last in, or the door to pick one. */
function FrontDoorRoute() {
  const known = useClusterStore((s) => s.contextsKnown);
  const last = useClusterStore((s) =>
    s.lastContext && s.contexts.some((c) => c.name === s.lastContext)
      ? s.lastContext
      : null
  );
  if (known && last) return <Navigate {...clusterLink(last)} replace />;
  return (
    <div className="h-screen overflow-auto bg-canvas text-fg-mid">
      <ClusterFrontDoor />
    </div>
  );
}
