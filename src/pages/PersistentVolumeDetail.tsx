import { Trash2 } from "lucide-react";

import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { DetailAction } from "@/components/resources/detail-blocks";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { ClaimRef } from "@/components/resources/storage-refs";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
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

  const tabs = [
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
        <DetailAction
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
