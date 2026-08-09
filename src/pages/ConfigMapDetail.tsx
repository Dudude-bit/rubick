import { useQuery } from "@tanstack/react-query";
import { Table2, Tag, Trash2 } from "lucide-react";

import { yamlTab } from "@/components/resources/yaml-tab";
import { connectionsTab } from "@/components/resources/connections-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { countMark, viewGlyph } from "@/components/resources/detail-tab";
import { DataSection } from "@/components/resources/data-rows";
import { DetailAction } from "@/components/resources/detail-blocks";
import { KeyValueSection } from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { ResourceType } from "@/lib/resource-registry";
import type { ConfigMapInfo } from "@/generated/types";

export function ConfigMapDetail() {
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
  } = useResourceDetail<ConfigMapInfo>({
    resourceKind: ResourceType.ConfigMap,
    fetchResource: (name, ns) => commands.getConfigmap(name, ns),
    deleteResource: (name, ns) => commands.deleteConfigmap(name, ns),
    defaultTab: "data",
  });

  const connections = useConnections(ResourceType.ConfigMap, name, namespace);

  const { data: configMapData = {}, isLoading: isDataLoading } = useQuery({
    queryKey: ["configmap-data", name, namespace],
    queryFn: async () => {
      if (!name || !namespace) return {};
      return commands.getConfigmapData(name, namespace);
    },
    enabled: !!name && !!namespace,
  });

  if (!configMap && !isLoading && !error) {
    return null;
  }

  const dataKeys = configMap?.dataKeys ?? [];
  const labels = configMap?.labels ?? {};
  const annotations = configMap?.annotations ?? {};

  const tabs = [
    {
      id: "data",
      label: "Data",
      glyph: viewGlyph(Table2),
      mark: countMark(dataKeys.length),
      // The keys are the object; the metadata is context, so it moves to a
      // tab of its own rather than sharing the fold with them.
      content: (
        <DataSection
          data={configMapData}
          keys={dataKeys}
          isLoading={isDataLoading}
          emptyMessage="This ConfigMap holds no keys"
        />
      ),
    },
    connectionsTab(connections),
    {
      id: "metadata",
      label: "Metadata",
      glyph: viewGlyph(Tag),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(labels).length}
            items={recordToKeyValues(labels)}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(annotations).length}
            items={recordToKeyValues(annotations)}
            emptyMessage="No annotations"
          />
        </>
      ),
    },
    yamlTab({
      title: "ConfigMap YAML",
      yaml: configMapYaml,
      resourceKind: ResourceType.ConfigMap,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      resource={configMap}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.ConfigMap}
      title={configMap?.name || name || ""}
      namespace={configMap?.namespace || namespace}
      createdAt={configMap?.createdAt}
      badges={
        <span className="text-[11px] text-fg-fnt">
          {dataKeys.length} {dataKeys.length === 1 ? "key" : "keys"}
        </span>
      }
      onBack={goBack}
      actions={
        <DetailAction
          label="Delete"
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
