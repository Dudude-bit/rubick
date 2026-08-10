import { Trash2 } from "lucide-react";

import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { connectionsTab } from "@/components/resources/connections-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { ClaimRef } from "@/components/resources/storage-refs";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { PersistentVolumeInfo } from "@/generated/types";

export function PersistentVolumeDetail() {
  const {
    name,
    resource: pv,
    isLoading,
    error,
    yaml: pvYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<PersistentVolumeInfo>({
    resourceKind: ResourceType.PersistentVolume,
    isClusterScoped: true,
    fetchResource: (name) => commands.getPersistentVolume(name),
    deleteResource: (name) => commands.deletePersistentVolume(name),
    defaultTab: "yaml",
  });

  const facts: KeyValue[] = [
    { label: "Capacity", value: pv?.capacity ?? "—", mono: true },
    {
      label: "Access modes",
      value: pv?.accessModes.length ? pv.accessModes.join(" · ") : "none",
      mono: true,
    },
    {
      label: "Claim",
      // A volume with no claim is storage nobody is using — the one fact on
      // this page that is worth a colour. Bound is the correct, quiet case.
      value: pv?.claim ? (
        <ClaimRef claim={pv.claim} />
      ) : (
        "unbound — no claim is using this volume"
      ),
      tone: pv?.claim ? undefined : "warn",
    },
    {
      label: "Storage class",
      value: pv?.storageClass ? (
        <ResourceRef
          kind={ResourceType.StorageClass}
          name={pv.storageClass}
          showKind={false}
        />
      ) : (
        "none"
      ),
    },
    { label: "Reclaim policy", value: pv?.reclaimPolicy ?? "—", mono: true },
    ...(pv?.reason
      ? [{ label: "Reason", value: pv.reason, tone: "err" as const }]
      : []),
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.PersistentVolume, pv);
  const intercept = useDeliveryIntercept(deliveryQuery);
  // Cluster-scoped, and the claim it names is in a namespace of its own. The
  // block above links to that claim; this says whether it is still there and
  // what it says about itself, which a link cannot.
  const connections = useConnections(ResourceType.PersistentVolume, name, null);

  const tabs = [
    connectionsTab(connections, deliveryQuery),
    yamlTab({
      title: "PersistentVolume YAML",
      yaml: pvYaml,
      resourceKind: ResourceType.PersistentVolume,
      resourceName: name || "",
      namespace: undefined,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      resource={pv}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.PersistentVolume}
      title={pv?.name || name || ""}
      statusBadge={pv && <StatusBadge status={pv.status} />}
      badges={
        pv && (
          <>
            <span className="font-mono text-[11px] text-fg-mut">
              {pv.capacity}
            </span>
            <span className="text-[11px] text-fg-fnt">
              {pv.accessModes.join(" · ") || "no access modes"}
            </span>
            {!pv.claim && (
              <span className="text-[11px] text-warn">unbound</span>
            )}
          </>
        )
      }
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
          label="Delete"
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
        />
      }
    >
      <KeyValueSection title="Volume" items={facts} className="max-w-lg" />
    </ResourceDetailLayout>
  );
}
