/**
 * The Integrations catalog: what this cluster has.
 *
 * A cluster's page, not a preference of this app's. A theme belongs to the
 * reader; cert-manager belongs to the cluster, which is why this lives
 * under the cluster's routes beside its workloads and not in Settings.
 */

import { IntegrationsCatalog } from "@/components/cluster/IntegrationsCatalog";
import { SectionHeader } from "@/components/ui/section";
import { useClusterStore } from "@/stores/clusterStore";
import { useT } from "@/i18n/useT";

export function IntegrationsList() {
  const t = useT();
  const currentContext = useClusterStore((state) => state.currentContext);

  return (
    <div className="flex max-w-3xl flex-col gap-[18px]">
      <SectionHeader
        title={t("nav", "integrations")}
        description={t("cluster", "integrationsHint")}
      />
      {currentContext ? (
        <IntegrationsCatalog />
      ) : (
        // An empty list and an unanswerable question look the same and
        // mean different things: one says the cluster has none of these,
        // the other that nothing was asked.
        <div className="max-w-[64ch]">
          <h3 className="text-xs font-medium text-fg">
            {t("cluster", "notConnected")}
          </h3>
          <p className="mt-1.5 text-xs text-fg-mut">
            {t("empty", "integrationsNoCluster")}
          </p>
        </div>
      )}
    </div>
  );
}

export default IntegrationsList;
