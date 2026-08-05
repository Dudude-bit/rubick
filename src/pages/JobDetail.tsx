import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { JobDetailInfo } from "@/generated/types";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RealtimeAge } from "@/components/ui/realtime";
import {
  Trash2,
  Briefcase,
  RefreshCw,
  CheckCircle,
  XCircle,
  Clock,
} from "lucide-react";
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

export function JobDetail() {
  const {
    name,
    namespace,
    resource: job,
    isLoading,
    error,
    refetch,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<JobDetailInfo>({
    resourceKind: ResourceType.Job,
    fetchResource: (name, ns) => commands.getJob(name, ns),
    deleteResource: (name, ns) => commands.deleteJob(name, ns),
    defaultTab: "overview",
  });

  // Fetch pods for this Job
  const { data: pods = [] } = useQuery({
    queryKey: ["job-pods", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
      try {
        const allPods = await commands.listPods({
          namespace: namespace,
          labelSelector: `job-name=${name}`,
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

  // Memoised so the `tabs` useMemo below can list `statusInfo` as a
  // direct dependency without losing memo benefit on every render
  // (a fresh object literal each time would defeat memoisation).
  const statusInfo = useMemo(() => {
    if (!job)
      return { variant: "secondary" as const, text: "Unknown", icon: Clock };
    if (job.status === "Complete") {
      return {
        variant: "success" as const,
        text: "Complete",
        icon: CheckCircle,
      };
    }
    if (job.status === "Failed") {
      return { variant: "destructive" as const, text: "Failed", icon: XCircle };
    }
    if (job.status === "Running") {
      return { variant: "warning" as const, text: "Running", icon: RefreshCw };
    }
    return { variant: "secondary" as const, text: job.status, icon: Clock };
  }, [job]);

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: "Overview",
        content: (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <InfoCard title="Job Configuration">
                <div className="space-y-1">
                  <InfoRow
                    label="Completions"
                    value={job?.completions ?? "Not set (1)"}
                  />
                  <InfoRow label="Parallelism" value={job?.parallelism ?? 1} />
                  <InfoRow
                    label="Backoff Limit"
                    value={job?.backoffLimit ?? 6}
                  />
                  {job?.activeDeadlineSeconds && (
                    <InfoRow
                      label="Deadline"
                      value={`${job.activeDeadlineSeconds}s`}
                    />
                  )}
                  <InfoRow
                    label="Created"
                    value={
                      <RealtimeAge timestamp={job?.createdAt} fallback="-" />
                    }
                  />
                </div>
              </InfoCard>

              <InfoCard title="Status">
                <div className="space-y-1">
                  <InfoRow
                    label="Status"
                    value={
                      <Badge variant={statusInfo.variant}>
                        {statusInfo.text}
                      </Badge>
                    }
                  />
                  <InfoRow label="Active" value={job?.active ?? 0} />
                  <InfoRow label="Succeeded" value={job?.succeeded ?? 0} />
                  <InfoRow label="Failed" value={job?.failed ?? 0} />
                  {job?.startTime && (
                    <InfoRow
                      label="Start Time"
                      value={<RealtimeAge timestamp={job.startTime} />}
                    />
                  )}
                  {job?.completionTime && (
                    <InfoRow
                      label="Completion Time"
                      value={<RealtimeAge timestamp={job.completionTime} />}
                    />
                  )}
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
            {(job?.containers || []).map((container) => (
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
            {(!job?.containers || job.containers.length === 0) && (
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
            title={job?.name || "Job YAML"}
            resourceKind={ResourceType.Job}
            resourceName={job?.name || name || ""}
            namespace={job?.namespace || namespace}
          />
        ),
      },
      {
        id: "conditions",
        label: "Conditions",
        content: <ConditionsDisplay conditions={job?.conditions || []} />,
      },
    ],
    [job, pods, yaml, copyYaml, namespace, name, statusInfo]
  );

  if (!job && !isLoading && !error) {
    return null;
  }

  return (
    <ResourceDetailLayout
      resource={job}
      isLoading={isLoading}
      error={error}
      resourceKind="Job"
      title={name || ""}
      namespace={namespace}
      statusBadge={
        <Badge variant={statusInfo.variant}>{statusInfo.text}</Badge>
      }
      badges={
        <>
          <Badge variant="outline">
            {job?.succeeded ?? 0}/{job?.completions ?? 1} completed
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
      icon={<Briefcase className="h-5 w-5" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      labels={job?.labels}
      annotations={job?.annotations}
    >
      {/* Related Resources (Owner References) */}
      {job && (
        <RelatedResources
          ownerReferences={job.ownerReferences}
          namespace={job.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
