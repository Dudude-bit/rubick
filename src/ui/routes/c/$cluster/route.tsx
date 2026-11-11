import { createFileRoute } from "@tanstack/react-router";

import { Layout } from "./-shell/Layout";
import { NotFoundPage } from "../../-components/NotFound";
import { appSearch } from "@/lib/app-search";
import { clusterOf } from "@/lib/links";
import { useClusterStore } from "@/stores/clusterStore";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { ClusterMissing, KubeconfigUnread } from "./-shell/ClusterMissing";
import { ClusterlessShell } from "./-shell/ClusterlessShell";
import { useConnectTo } from "./-shell/useConnectTo";

export const Route = createFileRoute("/c/$cluster")({
  validateSearch: appSearch,
  component: ClusterRoute,
  notFoundComponent: NotFoundPage,
});

export function ClusterRoute() {
  const { cluster } = Route.useParams();
  const known = useClusterStore((s) => s.contextsKnown);
  const listed = useClusterStore((s) =>
    s.contexts.some((c) => c.name === cluster)
  );
  const error = useClusterStore((s) => (s.contextsKnown ? null : s.error));
  // The address is the active tab's own, not a link opened in a tab that
  // stands elsewhere: the strip stays, since the other tabs and this one's
  // close are the way out. It stays while an activation is on its way too,
  // because the bridge that delivers it is mounted with the strip.
  const ofTab = useScopeTabStore(
    (s) =>
      s.pendingHref !== null ||
      s.tabs.some(
        (tab) => tab.id === s.activeId && clusterOf(tab.href) === cluster
      )
  );
  useConnectTo(cluster, known && listed);
  if (known && !listed && ofTab)
    return <Layout lost={<ClusterMissing cluster={cluster} ofTab />} />;
  if (known && !listed)
    return <ClusterlessShell page={<ClusterMissing cluster={cluster} />} />;
  if (!known && error)
    return (
      <ClusterlessShell
        page={<KubeconfigUnread cluster={cluster} error={error} />}
      />
    );
  return <Layout />;
}
