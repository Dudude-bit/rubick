import { Link } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { commands } from "@/lib/commands";
import type { CronJobDetailInfo } from "@/generated/types";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RealtimeAge } from "@/components/ui/realtime";
import { Trash2, CalendarClock, RefreshCw, Pause, Play } from "lucide-react";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { EnvironmentVariables } from "@/components/resources/EnvironmentVariables";
import { RelatedResources } from "@/components/resources/RelatedResources";
import {
  ResourceDetailLayout,
  InfoCard,
  InfoRow,
} from "@/components/resources/ResourceDetailLayout";

import { useResourceDetail } from "@/hooks";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";

export function CronJobDetail() {
  const {
    name,
    namespace,
    resource: cronJob,
    isLoading,
    error,
    refetch,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<CronJobDetailInfo>({
    resourceKind: ResourceType.CronJob,
    fetchResource: (name, ns) => commands.getCronjob(name, ns),
    deleteResource: (name, ns) => commands.deleteCronjob(name, ns),
    defaultTab: "overview",
  });

  // Fetch jobs created by this CronJob
  const { data: jobs = [] } = useQuery({
    queryKey: ["cronjob-jobs", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
      try {
        const allJobs = await commands.listJobs({
          namespace: namespace,
          labelSelector: null,
          fieldSelector: null,
          limit: null,
        });
        // Filter jobs owned by this CronJob (jobs have owner reference)
        return allJobs.filter((job) => job.name.startsWith(name));
      } catch {
        return [];
      }
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  if (!cronJob && !isLoading && !error) {
    return null;
  }

  const statusVariant = cronJob?.suspend ? "warning" : "success";
  const statusText = cronJob?.suspend ? "Suspended" : "Active";
  const StatusIcon = cronJob?.suspend ? Pause : Play;

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <InfoCard title="Schedule">
              <div className="space-y-1">
                <InfoRow
                  label="Schedule"
                  value={
                    <code className="text-sm bg-muted px-2 py-0.5 rounded">
                      {cronJob?.schedule || "-"}
                    </code>
                  }
                />
                {cronJob?.timezone && (
                  <InfoRow label="Timezone" value={cronJob.timezone} />
                )}
                <InfoRow
                  label="Concurrency Policy"
                  value={cronJob?.concurrencyPolicy || "Allow"}
                />
                {cronJob?.startingDeadlineSeconds && (
                  <InfoRow
                    label="Starting Deadline"
                    value={`${cronJob.startingDeadlineSeconds}s`}
                  />
                )}
                <InfoRow
                  label="Created"
                  value={
                    <RealtimeAge timestamp={cronJob?.createdAt} fallback="-" />
                  }
                />
              </div>
            </InfoCard>

            <InfoCard title="Status & History">
              <div className="space-y-1">
                <InfoRow
                  label="Status"
                  value={
                    <Badge variant={statusVariant} className="gap-1">
                      <StatusIcon className="h-3 w-3" />
                      {statusText}
                    </Badge>
                  }
                />
                <InfoRow label="Active Jobs" value={cronJob?.active ?? 0} />
                {cronJob?.lastSchedule && (
                  <InfoRow
                    label="Last Schedule"
                    value={<RealtimeAge timestamp={cronJob.lastSchedule} />}
                  />
                )}
                {cronJob?.lastSuccessfulTime && (
                  <InfoRow
                    label="Last Success"
                    value={
                      <RealtimeAge timestamp={cronJob.lastSuccessfulTime} />
                    }
                  />
                )}
                <InfoRow
                  label="Success History Limit"
                  value={cronJob?.successfulJobsHistoryLimit ?? 3}
                />
                <InfoRow
                  label="Failed History Limit"
                  value={cronJob?.failedJobsHistoryLimit ?? 1}
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
          {(cronJob?.containers || []).map((container) => (
            <Card key={container.name}>
              <CardHeader>
                <CardTitle className="text-lg">{container.name}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Image</span>
                    <span className="font-mono text-xs">{container.image}</span>
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
                        <span className="text-muted-foreground">Requests</span>
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
                {(container.env.length > 0 || container.envFrom.length > 0) && (
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
          {(!cronJob?.containers || cronJob.containers.length === 0) && (
            <p className="text-center text-muted-foreground py-8">
              No containers defined
            </p>
          )}
        </div>
      ),
    },
    {
      id: toPlural(ResourceType.Job),
      label: "Jobs",
      content: (
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-2">
              {jobs.map((job) => {
                const status = job.status || "Unknown";

                return (
                  <Link
                    key={job.name}
                    to={`/${toPlural(ResourceType.Job)}/${job.namespace}/${job.name}`}
                    className="flex items-center justify-between p-3 rounded-md hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <Badge
                        variant={
                          status === "Complete"
                            ? "success"
                            : status === "Failed"
                              ? "destructive"
                              : status === "Running"
                                ? "warning"
                                : "secondary"
                        }
                      >
                        {status}
                      </Badge>
                      <span className="font-medium">{job.name}</span>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <span>
                        {job.succeeded}/{job.completions ?? 1} completed
                      </span>
                      <RealtimeAge timestamp={job.createdAt} />
                    </div>
                  </Link>
                );
              })}
              {jobs.length === 0 && (
                <p className="text-center text-muted-foreground py-4">
                  No jobs found
                </p>
              )}
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
          yaml={yaml}
          onCopy={copyYaml}
          title={cronJob?.name || "CronJob YAML"}
          resourceKind={ResourceType.CronJob}
          resourceName={cronJob?.name || name || ""}
          namespace={cronJob?.namespace || namespace}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={cronJob}
      isLoading={isLoading}
      error={error}
      resourceKind="CronJob"
      title={name || ""}
      namespace={namespace}
      statusBadge={
        <Badge variant={statusVariant} className="gap-1">
          <StatusIcon className="h-3 w-3" />
          {statusText}
        </Badge>
      }
      badges={
        <>
          <Badge variant="outline">{cronJob?.schedule || "-"}</Badge>
          <Badge variant="outline">{cronJob?.active ?? 0} active</Badge>
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
      icon={<CalendarClock className="h-5 w-5" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      labels={cronJob?.labels}
      annotations={cronJob?.annotations}
    >
      {/* Related Resources (Owner References) */}
      {cronJob && (
        <RelatedResources
          ownerReferences={cronJob.ownerReferences}
          namespace={cronJob.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
