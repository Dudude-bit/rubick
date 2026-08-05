import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import {
  ResourceDetailLayout,
  InfoCard,
} from "@/components/resources/ResourceDetailLayout";
import { useResourceDetail } from "@/hooks";
import { ResourceType } from "@/lib/resource-registry";
import { Database } from "lucide-react";
import { commands } from "@/lib/commands";
import type { PersistentVolumeClaimInfo } from "@/generated/types";

import { StatusBadge } from "@/components/ui/status-badge";

export function PersistentVolumeClaimDetail() {
  const {
    name,
    namespace,
    resource: pvc,
    isLoading,
    error,
    yaml: pvcYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
  } = useResourceDetail<PersistentVolumeClaimInfo>({
    resourceKind: ResourceType.PersistentVolumeClaim,
    fetchResource: (name, ns) => commands.getPersistentVolumeClaim(name, ns),
    deleteResource: (name, ns) =>
      commands.deletePersistentVolumeClaim(name, ns),
    defaultTab: "details",
  });

  const tabs = [
    {
      id: "details",
      label: "Details",
      content: (
        <Card>
          <CardHeader>
            <CardTitle>Claim Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Status</p>
                <StatusBadge status={pvc?.status || ""} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Capacity</p>
                <p className="font-mono">{pvc?.capacity || "N/A"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Access Modes</p>
                <div className="flex flex-wrap gap-1">
                  {pvc?.accessModes.map((mode, i) => (
                    <Badge key={i} variant="outline">
                      {mode}
                    </Badge>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Storage Class</p>
                <p className="font-mono">{pvc?.storageClass || "default"}</p>
              </div>
              <div className="col-span-2">
                <p className="text-sm text-muted-foreground">Bound Volume</p>
                <p className="font-mono">{pvc?.volume || "Not bound yet"}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Age</p>
                <p>{pvc?.age}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="PersistentVolumeClaim YAML"
          yaml={pvcYaml}
          resourceKind={ResourceType.PersistentVolumeClaim}
          resourceName={name || ""}
          namespace={namespace}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={pvc}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.PersistentVolumeClaim}
      title={pvc?.name || name || ""}
      namespace={pvc?.namespace || namespace}
      badges={<StatusBadge status={pvc?.status || ""} />}
      icon={<Database className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
    >
      <div className="grid gap-4 md:grid-cols-4">
        <InfoCard title="Capacity">
          <div className="text-xl font-bold">{pvc?.capacity || "N/A"}</div>
        </InfoCard>

        <InfoCard title="Access Modes">
          <div className="flex flex-wrap gap-1">
            {pvc?.accessModes.map((mode, i) => (
              <Badge key={i} variant="secondary">
                {mode}
              </Badge>
            ))}
          </div>
        </InfoCard>

        <InfoCard title="Storage Class">
          <div className="text-xl font-bold">
            {pvc?.storageClass || "default"}
          </div>
        </InfoCard>

        <InfoCard title="Volume">
          <div className="text-sm font-mono truncate">
            {pvc?.volume || "Pending"}
          </div>
        </InfoCard>
      </div>
    </ResourceDetailLayout>
  );
}
