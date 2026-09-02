import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Table2, Tag, Trash2 } from "lucide-react";

import { yamlTab } from "@/components/resources/yaml-tab";
import { connectionsTab } from "@/components/resources/connections-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/resources/detail-tab";
import { DataSection } from "@/components/resources/data-rows";
import { useToast } from "@/components/ui/use-toast";
import { errorWords } from "@/i18n/say";
import { KeyValueSection } from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { ResourceType } from "@/lib/resource-registry";
import type { ConfigMapInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

export function ConfigMapDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: configMap,
    isLoading,
    error,
    yaml: configMapYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
    freshness,
  } = useResourceDetail<ConfigMapInfo>({
    resourceKind: ResourceType.ConfigMap,
    fetchResource: (name, ns) => commands.getConfigmap(name, ns),
    deleteResource: (name, ns) => commands.deleteConfigmap(name, ns),
    defaultTab: "data",
  });

  const connections = useConnections(ResourceType.ConfigMap, name, namespace);

  const { data: configMapData, isLoading: isDataLoading } = useQuery({
    queryKey: ["configmap-data", name, namespace],
    queryFn: () => commands.getConfigmapData(name!, namespace!),
    enabled: !!name && !!namespace,
  });

  // One key at a time rather than the whole object as YAML. The YAML editor
  // is still there and is still the way to add or remove a key; this is for
  // changing a value, which is what a reader was doing when the indentation
  // got in the way (#107).
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const writeKey = async (key: string, value: string) => {
    try {
      await commands.setConfigmapKey(name!, key, value, namespace!);
      await queryClient.invalidateQueries({
        queryKey: ["configmap-data", name, namespace],
      });
      toast({ title: t("action", "keyUpdated", { key }) });
    } catch (error) {
      toast({
        title: t("action", "keyUpdateFailed", { key }),
        description: errorWords(error, t),
        variant: "destructive",
      });
    }
  };

  const deliveryQuery = deliveryOfKind(ResourceType.ConfigMap, configMap);
  const intercept = useDeliveryIntercept(deliveryQuery);

  if (!configMap && !isLoading && !error) {
    return null;
  }

  const dataKeys = configMap?.dataKeys ?? [];
  const labels = configMap?.labels ?? {};
  const annotations = configMap?.annotations ?? {};

  const tabs = [
    {
      id: "data",
      label: t("columns", "data"),
      glyph: viewGlyph(Table2),
      mark: countMark(dataKeys.length),
      // The keys are the object; the metadata is context, so it moves to a
      // tab of its own rather than sharing the fold with them.
      content: (
        <DataSection
          data={configMapData?.values ?? {}}
          withheld={configMapData?.withheld}
          binary={configMapData?.binary}
          keys={dataKeys}
          onEditKey={writeKey}
          isLoading={isDataLoading}
          emptyMessage={t("empty", "kindHoldsNoKeys", { kind: "ConfigMap" })}
        />
      ),
    },
    connectionsTab(connections, t, deliveryQuery),
    {
      id: "metadata",
      label: t("nav", "metadata"),
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(labels).length}
            items={recordToKeyValues(labels)}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
            count={Object.keys(annotations).length}
            items={recordToKeyValues(annotations)}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    yamlTab({
      title: t("action", "kindYaml", { kind: "ConfigMap" }),
      yaml: configMapYaml,
      resourceKind: ResourceType.ConfigMap,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={configMap}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.ConfigMap}
      title={configMap?.name || name || ""}
      namespace={configMap?.namespace || namespace}
      createdAt={configMap?.createdAt}
      badges={
        <span className="text-[11px] text-fg-fnt">
          {t("count", "keys", { n: dataKeys.length })}
        </span>
      }
      onBack={goBack}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
          label={t("action", "delete")}
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
        />
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}
