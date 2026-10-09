import { createFileRoute } from "@tanstack/react-router";

import { Layout } from "./-shell/Layout";
import { NotFoundPage } from "../../-components/NotFound";
import { appSearch } from "@/lib/app-search";
import { useClusterStore } from "@/stores/clusterStore";
import { ClusterMissing, KubeconfigUnread } from "./-shell/ClusterMissing";
import { useConnectTo } from "./-shell/useConnectTo";

export const Route = createFileRoute("/c/$cluster")({
  validateSearch: appSearch,
  component: ClusterRoute,
  notFoundComponent: NotFoundPage,
});

function ClusterRoute() {
  const { cluster } = Route.useParams();
  const known = useClusterStore((s) => s.contextsKnown);
  const listed = useClusterStore((s) =>
    s.contexts.some((c) => c.name === cluster)
  );
  const error = useClusterStore((s) => (s.contextsKnown ? null : s.error));
  useConnectTo(cluster, known && listed);
  if (known && !listed)
    return <Layout page={<ClusterMissing cluster={cluster} />} />;
  if (!known && error)
    return (
      <Layout page={<KubeconfigUnread cluster={cluster} error={error} />} />
    );
  return <Layout />;
}
