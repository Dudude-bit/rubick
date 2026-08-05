import { useMemo } from "react";
import { Section, SectionHeader } from "@/components/ui/section";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { StatefulSetDetailInfo } from "@/generated/types";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RealtimeAge } from "@/components/ui/realtime";
import { Trash2, Database, RefreshCw } from "lucide-react";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { ConditionsDisplay } from "@/components/resources/ConditionsDisplay";
import { EnvironmentVariables } from "@/components/resources/EnvironmentVariables";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { PodListCard } from "@/components/resources/PodListCard";
import {
  ResourceDetailLayout,
  InfoCard,
  InfoRow,
} from "@/components/resources/ResourceDetailLayout";

import { useResourceDetail } from "@/hooks";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";

export function StatefulSetDetail() {
  const {
    name,
    namespace,
    resource: statefulSet,
    isLoading,
    error,
    refetch,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<StatefulSetDetailInfo>({
    resourceKind: ResourceType.StatefulSet,
    fetchResource: (name, ns) => commands.getStatefulset(name, ns),
    deleteResource: (name, ns) => commands.deleteStatefulset(name, ns),
    defaultTab: "overview",
  });

  // Fetch pods for this StatefulSet
  const { data: pods = [] } = useQuery({
    queryKey: ["statefulset-pods", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
      try {
        // StatefulSet pods typically have a label app=<statefulset-name>
        const allPods = await commands.listPods({
          namespace: namespace,
          labelSelector: `app=${name}`,
          fieldSelector: null,
          limit: null,
          statusFilter: null,
          selector: null,
          nodeName: null,
        });
        return allPods;
      } catch {
        return [];
      }
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  const isReady = statefulSet?.replicas.ready === statefulSet?.replicas.desired;
  const statusVariant = isReady ? "success" : "warning";
  const statusText = isReady ? "Ready" : "Updating";

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: "Overview",
        content: (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <InfoCard title="StatefulSet Info">
                <div className="space-y-1">
                  <InfoRow
                    label="Service Name"
                    value={statefulSet?.serviceName || "-"}
                  />
                  <InfoRow
                    label="Pod Management"
                    value={statefulSet?.podManagementPolicy || "OrderedReady"}
                  />
                  <InfoRow
                    label="Update Strategy"
                    value={statefulSet?.updateStrategy || "RollingUpdate"}
                  />
                  <InfoRow
                    label="Created"
                    value={
                      <RealtimeAge
                        timestamp={statefulSet?.createdAt}
                        fallback="-"
                      />
                    }
                  />
                </div>
              </InfoCard>

              <InfoCard title="Replicas">
                <div className="space-y-1">
                  <InfoRow
                    label="Desired"
                    value={statefulSet?.replicas.desired ?? 0}
                  />
                  <InfoRow
                    label="Current"
                    value={statefulSet?.replicas.current ?? 0}
                  />
                  <InfoRow
                    label="Ready"
                    value={statefulSet?.replicas.ready ?? 0}
                  />
                </div>
              </InfoCard>
            </div>
          </div>
        ),
      },
      {
        id: "containers",
        label: "Containers",
        content: (
          <div className="space-y-4">
            {(statefulSet?.containers || []).map((container) => (
              <Section key={container.name}>
                <SectionHeader title={container.name} />
                <div className="space-y-4">
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Image</span>
                      <span className="font-mono text-xs">
                        {container.image}
                      </span>
                    </div>
                    {container.ports.length > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Ports</span>
                        <span>{container.ports.join(", ")}</span>
                      </div>
                    )}
                    {container.resources.requests &&
                      Object.keys(container.resources.requests).length > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">
                            Requests
                          </span>
                          <span>
                            {Object.entries(container.resources.requests)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(", ")}
                          </span>
                        </div>
                      )}
                    {container.resources.limits &&
                      Object.keys(container.resources.limits).length > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Limits</span>
                          <span>
                            {Object.entries(container.resources.limits)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(", ")}
                          </span>
                        </div>
                      )}
                  </div>

                  {/* Environment Variables */}
                  {(container.env.length > 0 ||
                    container.envFrom.length > 0) && (
                    <EnvironmentVariables
                      env={container.env}
                      envFrom={container.envFrom}
                      containerName={container.name}
                      namespace={namespace}
                    />
                  )}
                </div>
              </Section>
            ))}
            {(!statefulSet?.containers ||
              statefulSet.containers.length === 0) && (
              <p className="text-center text-muted-foreground py-8">
                No containers defined
              </p>
            )}
          </div>
        ),
      },
      {
        id: toPlural(ResourceType.Pod),
        label: "Pods",
        content: <PodListCard pods={pods} />,
      },
      {
        id: "yaml",
        label: "YAML",
        content: (
          <YamlTabContent
            yaml={yaml}
            onCopy={copyYaml}
            title={statefulSet?.name || "StatefulSet YAML"}
            resourceKind={ResourceType.StatefulSet}
            resourceName={statefulSet?.name || name || ""}
            namespace={statefulSet?.namespace || namespace}
          />
        ),
      },
      {
        id: "conditions",
        label: "Conditions",
        content: (
          <ConditionsDisplay conditions={statefulSet?.conditions || []} />
        ),
      },
    ],
    [statefulSet, pods, yaml, copyYaml, namespace, name]
  );

  if (!statefulSet && !isLoading && !error) {
    return null;
  }

  return (
    <ResourceDetailLayout
      resource={statefulSet}
      isLoading={isLoading}
      error={error}
      resourceKind="StatefulSet"
      title={name || ""}
      namespace={namespace}
      statusBadge={<Badge variant={statusVariant}>{statusText}</Badge>}
      badges={
        <>
          <Badge variant="outline">
            {statefulSet?.replicas.ready ?? 0}/
            {statefulSet?.replicas.desired ?? 0} ready
          </Badge>
        </>
      }
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => deleteMutation?.mutate()}
            disabled={deleteMutation?.isPending}
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </>
      }
      icon={<Database className="h-5 w-5" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      labels={statefulSet?.labels}
      annotations={statefulSet?.annotations}
    >
      {/* Related Resources (Owner References) */}
      {statefulSet && (
        <RelatedResources
          ownerReferences={statefulSet.ownerReferences}
          namespace={statefulSet.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
