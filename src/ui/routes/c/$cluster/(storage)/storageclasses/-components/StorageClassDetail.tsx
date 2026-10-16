import { useCallback } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { Info, SlidersHorizontal } from "lucide-react";

import type { ShareContribution } from "@/components/share/contribution";
import {
  storageClassFacts,
  storageClassFactsSection,
} from "@/lib/share/storage-class-share";
import { yamlTab } from "../../../-object/yaml-tab";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/object/detail-tab";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { StorageClassInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";

export function StorageClassDetail() {
  const t = useT();
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
    freshness,
  } = useResourceDetail<StorageClassInfo>({
    resourceKind: ResourceType.StorageClass,
    isClusterScoped: true,
    fetchResource: (name) => commands.getStorageClass(name),
    deleteResource: (name) => commands.deleteStorageClass(name),
    defaultTab: "overview",
  });

  const events = useObjectEvents(ResourceType.StorageClass, name, null, {
    refresh: "slow",
  });

  const parameters = sc?.parameters ?? {};

  const facts: KeyValue[] = sc
    ? storageClassFacts(sc, t).map(({ label, text, mono }) => ({
        label,
        value: text,
        mono,
      }))
    : [];

  const deliveryQuery = deliveryOfKind(ResourceType.StorageClass, sc);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const share = useCallback((): ShareContribution => {
    if (!sc) return {};
    return { sections: [storageClassFactsSection(sc, t)] };
  }, [sc, t]);

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <KeyValueSection
          title={t("columns", "storageClass")}
          items={facts}
          className="max-w-lg"
        />
      ),
    },
    {
      id: "parameters",
      label: t("columns", "parameters"),
      glyph: viewGlyph(SlidersHorizontal),
      mark: countMark(Object.keys(parameters).length),
      content: (
        <KeyValueSection
          title={t("columns", "parameters")}
          count={Object.keys(parameters).length || undefined}
          items={recordToKeyValues(parameters)}
          emptyMessage={t("empty", "noParameters")}
        />
      ),
    },
    eventsTab(events, t, { kind: ResourceType.StorageClass, name: name ?? "" }),
    yamlTab({
      title: t("action", "kindYaml", { kind: "StorageClass" }),
      yaml: scYaml,
      resourceKind: ResourceType.StorageClass,
      resourceName: name || "",
      namespace: undefined,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={sc}
      share={share}
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
                {t("empty", "defaultClassBadge")}
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
        <DeleteAction
          kind={ResourceType.StorageClass}
          name={sc?.name || name || ""}
          detail={sc}
          intercept={intercept("Delete")}
          mutation={deleteMutation}
        />
      }
    />
  );
}
