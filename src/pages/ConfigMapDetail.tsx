import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
import { AnnotationsDisplay } from "@/components/resources/AnnotationsDisplay";
import { ReferencedBy } from "@/components/resources/ReferencedBy";
import {
  InfoCard,
  ResourceDetailLayout,
} from "@/components/resources/ResourceDetailLayout";
import { KeyValueList } from "@/components/shared";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { FileText } from "lucide-react";
import { commands } from "@/lib/commands";
import { useQuery } from "@tanstack/react-query";
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
  } = useResourceDetail<ConfigMapInfo>({
    resourceKind: ResourceType.ConfigMap,
    fetchResource: (name, ns) => commands.getConfigmap(name, ns),
    deleteResource: (name, ns) => commands.deleteConfigmap(name, ns),
    defaultTab: "data",
  });

  // Fetch actual data for the ConfigMap
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
      content: (
        <KeyValueList
          data={configMapData}
          title="Data"
          isSensitive={false}
          isLoading={isDataLoading}
          emptyMessage="No data keys defined"
        />
      ),
    },
    {
      id: "references",
      label: "Referenced By",
      content:
        name && namespace ? (
          <ReferencedBy
            resourceType="ConfigMap"
            name={name}
            namespace={namespace}
          />
        ) : null,
    },
    {
      id: "metadata",
      label: "Metadata",
      content: (
        <div className="space-y-4">
          <LabelsDisplay labels={labels} title="Labels" />
          <AnnotationsDisplay annotations={annotations} />
        </div>
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="ConfigMap YAML"
          yaml={configMapYaml}
          resourceKind={ResourceType.ConfigMap}
          resourceName={name || ""}
          namespace={namespace}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={configMap}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.ConfigMap}
      title={configMap?.name || ""}
      namespace={configMap?.namespace}
      icon={<FileText className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <InfoCard title="Data Keys">
          <div className="text-xl font-bold">{dataKeys.length}</div>
        </InfoCard>

        <InfoCard title="Labels">
          <div className="text-xl font-bold">{Object.keys(labels).length}</div>
        </InfoCard>
      </div>
    </ResourceDetailLayout>
  );
}
