/**
 * The Integrations catalog, at its own door.
 *
 * It used to be a Settings section, and that shirt never fit: what a
 * cluster has is not a preference of this app's. A theme belongs to the
 * reader; cert-manager belongs to the cluster. Splitting the doors is what
 * lets the sidebar say both things plainly — Settings holds decisions,
 * this page holds an inventory.
 *
 * The content is the same one screen allowed to name an extension, so the
 * search context it indexes itself under comes along with it.
 */

import { IntegrationsSettings } from "@/components/settings/IntegrationsSettings";
import {
  SettingsSearchProvider,
  SettingsSectionScope,
} from "@/components/settings/settings-search";
import { SectionHeader } from "@/components/ui/section";
import { useClusterStore } from "@/stores/clusterStore";

export function IntegrationsList() {
  const currentContext = useClusterStore((state) => state.currentContext);

  return (
    <SettingsSearchProvider>
      <div className="flex max-w-3xl flex-col gap-[18px]">
        <SectionHeader
          title="Integrations"
          description="What this cluster has that the app can use. Most of it is detected by whether its CRDs exist; anything with its own address is configured here, per cluster."
        />
        {currentContext ? (
          <SettingsSectionScope id="integrations">
            <IntegrationsSettings />
          </SettingsSectionScope>
        ) : (
          // An empty list and an unanswerable question look the same and
          // mean different things: one says the cluster has none of these,
          // the other that nothing was asked.
          <div className="max-w-[64ch]">
            <h3 className="text-xs font-medium text-fg">
              No cluster connected
            </h3>
            <p className="mt-1.5 text-xs text-fg-mut">
              Connect a cluster and this will say what it has. Every extension
              here is detected by asking the API server for its CRDs, and there
              is no API server to ask.
            </p>
          </div>
        )}
      </div>
    </SettingsSearchProvider>
  );
}

export default IntegrationsList;
