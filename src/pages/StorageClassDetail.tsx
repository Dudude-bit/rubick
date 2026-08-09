import { SlidersHorizontal, Trash2 } from "lucide-react";

import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/resources/detail-tab";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { StorageClassInfo } from "@/generated/types";

export function StorageClassDetail() {
  const {
    name,
    resource: sc,
    isLoading,
    error,
    yaml: scYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<StorageClassInfo>({
    resourceKind: ResourceType.StorageClass,
    isClusterScoped: true,
    fetchResource: (name) => commands.getStorageClass(name),
    deleteResource: (name) => commands.deleteStorageClass(name),
    defaultTab: "parameters",
  });

  const parameters = sc?.parameters ?? {};

  const facts: KeyValue[] = [
    { label: "Provisioner", value: sc?.provisioner ?? "—", mono: true },
    {
      label: "Default class",
      // The one question people open this page to answer: does a claim that
      // names no class land here?
      value: sc?.isDefault
        ? "yes — claims that name no class use this one"
        : "no",
    },
    { label: "Reclaim policy", value: sc?.reclaimPolicy ?? "—", mono: true },
    { label: "Binding mode", value: sc?.volumeBindingMode ?? "—", mono: true },
    {
      label: "Volume expansion",
      value: sc?.allowVolumeExpansion
        ? "allowed"
        : "not allowed — claims cannot grow",
    },
  ];

  const deliveryQuery = deliveryOfKind(ResourceType.StorageClass, sc);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const tabs = [
    {
      id: "parameters",
      label: "Parameters",
      glyph: viewGlyph(SlidersHorizontal),
      mark: countMark(Object.keys(parameters).length),
      content: (
        <KeyValueSection
          title="Parameters"
          count={Object.keys(parameters).length || undefined}
          items={recordToKeyValues(parameters)}
          emptyMessage="No parameters — the provisioner uses its own defaults."
        />
      ),
    },
    yamlTab({
      title: "StorageClass YAML",
      yaml: scYaml,
      resourceKind: ResourceType.StorageClass,
      resourceName: name || "",
      namespace: undefined,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      resource={sc}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.StorageClass}
      title={sc?.name || name || ""}
      badges={
        sc && (
          <>
            {sc.isDefault && (
              <span className="text-[11px] font-medium text-fg">
                default class
              </span>
            )}
            <span className="font-mono text-[11px] text-fg-mut">
              {sc.provisioner}
            </span>
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
      <KeyValueSection
        title="Storage class"
        items={facts}
        className="max-w-lg"
      />
    </ResourceDetailLayout>
  );
}
