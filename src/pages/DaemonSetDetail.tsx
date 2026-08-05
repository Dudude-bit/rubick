import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { DaemonSetDetailInfo } from "@/generated/types";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RealtimeAge } from "@/components/ui/realtime";
import { Trash2, Server, RefreshCw } from "lucide-react";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { ConditionsDisplay } from "@/components/resources/ConditionsDisplay";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
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

export function DaemonSetDetail() {
  const {
    name,
    namespace,
    resource: daemonSet,
    isLoading,
    error,
    refetch,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<DaemonSetDetailInfo>({
    resourceKind: ResourceType.DaemonSet,
    fetchResource: (name, ns) => commands.getDaemonset(name, ns),
    deleteResource: (name, ns) => commands.deleteDaemonset(name, ns),
    defaultTab: "overview",
  });

  // Fetch pods for this DaemonSet
  const { data: pods = [] } = useQuery({
    queryKey: ["daemonset-pods", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
      try {
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

  const isReady = daemonSet?.ready === daemonSet?.desired;
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
              <InfoCard title="DaemonSet Info">
                <div className="space-y-1">
                  <InfoRow
                    label="Update Strategy"
                    value={daemonSet?.updateStrategy || "RollingUpdate"}
                  />
                  <InfoRow
                    label="Created"
                    value={
                      <RealtimeAge
                        timestamp={daemonSet?.createdAt}
                        fallback="-"
                      />
                    }
                  />
                </div>
              </InfoCard>

              <InfoCard title="Status">
                <div className="space-y-1">
                  <InfoRow label="Desired" value={daemonSet?.desired ?? 0} />
                  <InfoRow label="Current" value={daemonSet?.current ?? 0} />
                  <InfoRow label="Ready" value={daemonSet?.ready ?? 0} />
                  <InfoRow
                    label="Up-to-date"
                    value={daemonSet?.upToDate ?? 0}
                  />
                  <InfoRow
                    label="Available"
                    value={daemonSet?.available ?? 0}
                  />
                </div>
              </InfoCard>
            </div>

            {/* Selector */}
            {daemonSet?.selector &&
              Object.keys(daemonSet.selector).length > 0 && (
                <LabelsDisplay labels={daemonSet.selector} title="Selector" />
              )}
          </div>
        ),
      },
      {
        id: "containers",
        label: "Containers",
        content: (
          <div className="space-y-4">
            {(daemonSet?.containers || []).map((container) => (
              <Card key={container.name}>
                <CardHeader>
                  <CardTitle className="text-lg">{container.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
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
                </CardContent>
              </Card>
            ))}
            {(!daemonSet?.containers || daemonSet.containers.length === 0) && (
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
            title={daemonSet?.name || "DaemonSet YAML"}
            resourceKind={ResourceType.DaemonSet}
            resourceName={daemonSet?.name || name || ""}
            namespace={daemonSet?.namespace || namespace}
          />
        ),
      },
      {
        id: "conditions",
        label: "Conditions",
        content: <ConditionsDisplay conditions={daemonSet?.conditions || []} />,
      },
    ],
    [daemonSet, pods, yaml, copyYaml, namespace, name]
  );

  if (!daemonSet && !isLoading && !error) {
    return null;
  }

  return (
    <ResourceDetailLayout
      resource={daemonSet}
      isLoading={isLoading}
      error={error}
      resourceKind="DaemonSet"
      title={name || ""}
      namespace={namespace}
      statusBadge={<Badge variant={statusVariant}>{statusText}</Badge>}
      badges={
        <>
          <Badge variant="outline">
            {daemonSet?.ready ?? 0}/{daemonSet?.desired ?? 0} ready
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
      icon={<Server className="h-5 w-5" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      labels={daemonSet?.labels}
      annotations={daemonSet?.annotations}
    >
      {/* Related Resources (Owner References) */}
      {daemonSet && (
        <RelatedResources
          ownerReferences={daemonSet.ownerReferences}
          namespace={daemonSet.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
