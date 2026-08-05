import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import {
  ResourceDetailLayout,
  InfoCard,
} from "@/components/resources/ResourceDetailLayout";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { Layers, Star } from "lucide-react";
import { commands } from "@/lib/commands";
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
  } = useResourceDetail<StorageClassInfo>({
    resourceKind: ResourceType.StorageClass,
    isClusterScoped: true,
    fetchResource: (name) => commands.getStorageClass(name),
    deleteResource: (name) => commands.deleteStorageClass(name),
    defaultTab: "details",
  });

  const parameters = sc?.parameters ?? {};

  const tabs = [
    {
      id: "details",
      label: "Details",
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Storage Class Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Provisioner</p>
                <code className="text-sm rounded bg-muted px-2 py-1">
                  {sc?.provisioner}
                </code>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Reclaim Policy</p>
                <Badge variant="outline">{sc?.reclaimPolicy}</Badge>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">
                  Volume Binding Mode
                </p>
                <Badge variant="secondary">{sc?.volumeBindingMode}</Badge>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Allow Expansion</p>
                <Badge
                  variant={sc?.allowVolumeExpansion ? "default" : "outline"}
                >
                  {sc?.allowVolumeExpansion ? "Yes" : "No"}
                </Badge>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Default</p>
                {sc?.isDefault ? (
                  <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
                    <Star className="mr-1 h-3 w-3 fill-yellow-500" />
                    Yes
                  </Badge>
                ) : (
                  <Badge variant="outline">No</Badge>
                )}
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Age</p>
                <p>{sc?.age}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ),
    },
    {
      id: "parameters",
      label: "Parameters",
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Parameters</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(parameters).length > 0 ? (
              <div className="space-y-2">
                {Object.entries(parameters).map(([key, value]) => (
                  <div key={key} className="rounded-lg border p-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      {key}
                    </p>
                    <p className="font-mono text-sm break-all">{value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">No parameters defined</p>
            )}
          </CardContent>
        </Card>
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="StorageClass YAML"
          yaml={scYaml}
          resourceKind={ResourceType.StorageClass}
          resourceName={name || ""}
          namespace={undefined}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={sc}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.StorageClass}
      title={sc?.name || name || ""}
      namespace={undefined}
      badges={
        <>
          {sc?.isDefault && (
            <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">
              <Star className="mr-1 h-3 w-3 fill-yellow-500" />
              Default
            </Badge>
          )}
          {sc?.allowVolumeExpansion && (
            <Badge variant="outline">Expansion Allowed</Badge>
          )}
        </>
      }
      icon={<Layers className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <InfoCard title="Provisioner">
          <code className="text-sm">{sc?.provisioner}</code>
        </InfoCard>

        <InfoCard title="Reclaim Policy">
          <Badge variant="outline">{sc?.reclaimPolicy}</Badge>
        </InfoCard>

        <InfoCard title="Binding Mode">
          <Badge variant="secondary">{sc?.volumeBindingMode}</Badge>
        </InfoCard>

        <InfoCard title="Volume Expansion">
          <Badge variant={sc?.allowVolumeExpansion ? "default" : "outline"}>
            {sc?.allowVolumeExpansion ? "Allowed" : "Disabled"}
          </Badge>
        </InfoCard>
      </div>
    </ResourceDetailLayout>
  );
}
