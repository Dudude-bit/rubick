import { Badge } from "@/components/ui/badge";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
import { AnnotationsDisplay } from "@/components/resources/AnnotationsDisplay";
import {
  InfoCard,
  ResourceDetailLayout,
} from "@/components/resources/ResourceDetailLayout";
import { ReferencedBy } from "@/components/resources";
import { KeyValueList } from "@/components/shared";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { Lock } from "lucide-react";
import { commands } from "@/lib/commands";
import { useQuery } from "@tanstack/react-query";
import type { SecretInfo } from "@/generated/types";
import { StatusBadge } from "@/components/ui/status-badge";

const getSecretTypeColor = (type: string): string => {
  switch (type) {
    case "kubernetes.io/tls":
      return "bg-blue-500/20 text-blue-500";
    case "kubernetes.io/dockerconfigjson":
      return "bg-purple-500/20 text-purple-500";
    case "kubernetes.io/service-account-token":
      return "bg-green-500/20 text-green-500";
    default:
      return "bg-gray-500/20 text-gray-500";
  }
};

export function SecretDetail() {
  const {
    name,
    namespace,
    resource: secret,
    isLoading,
    error,
    yaml: secretYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
  } = useResourceDetail<SecretInfo>({
    resourceKind: ResourceType.Secret,
    fetchResource: (name, ns) => commands.getSecret(name, ns),
    deleteResource: (name, ns) => commands.deleteSecret(name, ns),
    defaultTab: "data",
  });

  // Fetch decoded data for the Secret
  const { data: secretData = {}, isLoading: isLoadingData } = useQuery({
    queryKey: ["secret-data", name, namespace],
    queryFn: async () => {
      if (!name || !namespace) return {};
      return commands.getSecretData(name, namespace);
    },
    enabled: !!name && !!namespace,
  });

  if (!secret && !isLoading && !error) {
    return null;
  }

  const dataKeys = secret?.dataKeys ?? [];
  const labels = secret?.labels ?? {};
  const annotations = secret?.annotations ?? {};
  const secretType = secret?.type ?? "Opaque";

  const tabs = [
    {
      id: "data",
      label: "Data",
      content: (
        <KeyValueList
          data={secretData}
          title="Data"
          isSensitive={true}
          showSensitiveBadge={true}
          isLoading={isLoadingData}
          emptyMessage="No data keys defined"
        />
      ),
    },
    {
      id: "references",
      label: "Referenced By",
      content: (
        <ReferencedBy
          resourceType="Secret"
          name={name || ""}
          namespace={namespace || ""}
        />
      ),
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
          title="Secret YAML (Redacted)"
          yaml={secretYaml}
          resourceKind={ResourceType.Secret}
          resourceName={name || ""}
          namespace={namespace}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={secret}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Secret}
      title={secret?.name || ""}
      namespace={secret?.namespace}
      statusBadge={
        secret && (
          <Badge className={getSecretTypeColor(secretType)}>
            {secretType.replace("kubernetes.io/", "")}
          </Badge>
        )
      }
      icon={<Lock className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      <div className="grid gap-4 md:grid-cols-3">
        <InfoCard title="Type">
          <StatusBadge status={secretType.replace("kubernetes.io/", "")} />
        </InfoCard>

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
