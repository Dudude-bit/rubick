import { ClusterList } from "@/components/cluster/ClusterList";
import { EmptyPage } from "../../../-components/NotFound";
import { useClusterFilter } from "@/hooks/useClusterFilter";
import { useOpenCluster } from "@/hooks/useOpenCluster";
import { useT } from "@/i18n/useT";

/** The address names a cluster the kubeconfig was read and does not list. */
export function ClusterMissing({ cluster }: { cluster: string }) {
  const t = useT();
  const filter = useClusterFilter();
  const openCluster = useOpenCluster();
  return (
    <EmptyPage
      title={t("empty", "clusterMissing", { cluster })}
      body={t("empty", "clusterMissingBody")}
    >
      <div className="w-full">
        <ClusterList
          contexts={filter.shown}
          total={filter.total}
          filter={filter.filter}
          onFilterChange={filter.setFilter}
          query={filter.query}
          inputRef={filter.inputRef}
          onSelect={openCluster}
          autoFocus={false}
        />
      </div>
    </EmptyPage>
  );
}

/** The kubeconfig could not be read, so whether it lists the cluster is unknown. */
export function KubeconfigUnread({
  cluster,
  error,
}: {
  cluster: string;
  error: string;
}) {
  const t = useT();
  return (
    <EmptyPage
      title={t("empty", "kubeconfigUnread")}
      body={t("empty", "kubeconfigUnreadBody", { cluster, error })}
    />
  );
}
