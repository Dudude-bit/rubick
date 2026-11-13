import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ClusterList } from "@/components/cluster/ClusterList";
import { EmptyPage } from "@/components/ui/empty-page";
import { useClusterFilter } from "@/hooks/useClusterFilter";
import { useKubeconfigPath } from "@/hooks/useKubeconfigPath";
import { useOpenCluster } from "@/hooks/useOpenCluster";
import { useShownPath } from "@/lib/hide-paths";
import { useT } from "@/i18n/useT";

/** The address names a cluster the kubeconfig was read and does not list. */
export function ClusterMissing({
  cluster,
  ofTab = false,
}: {
  cluster: string;
  /** A tab that was on the cluster brought the reader here, not a link. */
  ofTab?: boolean;
}) {
  const t = useT();
  const filter = useClusterFilter();
  const openCluster = useOpenCluster();
  return (
    <EmptyPage
      title={t("empty", "clusterMissing", { cluster })}
      body={t("empty", ofTab ? "clusterMissingTabBody" : "clusterMissingBody")}
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
  const show = useShownPath();
  const [reloading, setReloading] = useState(false);
  const kubeconfig = useKubeconfigPath();
  return (
    <EmptyPage
      icon={TriangleAlert}
      title={t("empty", "kubeconfigUnread")}
      body={t("empty", "kubeconfigUnreadBody", { cluster, error: show(error) })}
    >
      <Button
        variant="outline"
        size="sm"
        pending={reloading}
        onClick={() => {
          setReloading(true);
          void Promise.resolve(kubeconfig.reload())
            .catch(() => undefined)
            .finally(() => setReloading(false));
        }}
      >
        {t("action", "reload")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={kubeconfig.isPending}
        onClick={() => void kubeconfig.choose()}
      >
        {t("action", "chooseDifferentFile")}
      </Button>
    </EmptyPage>
  );
}
