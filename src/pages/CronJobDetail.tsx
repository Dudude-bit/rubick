import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Info, Layers2, Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  countMark,
  kindGlyph,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { ContainerRows } from "@/components/resources/container-rows";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { JobRows } from "@/components/resources/child-rows";
import {
  describeCron,
  nextCronRun,
} from "@/components/resources/cron-schedule";
import { Composition, Headline } from "@/components/resources/detail-blocks";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "@/components/resources/workload-overview";
import { serviceAccountRow } from "@/components/resources/identity-rows";
import { WorkloadUsage } from "@/components/resources/workload-usage";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useRealtimeAge, useRealtimeCountdown } from "@/hooks/useRealtimeAge";
import { commands } from "@/lib/commands";
import { matchCronJobPods } from "@/lib/metrics";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";
import type { CronJobDetailInfo } from "@/generated/types";

/**
 * The three facts a CronJob page exists to answer, at a glance.
 *
 * Kubernetes reports neither the next fire time nor a readable schedule, so
 * both are derived here; when the expression cannot be parsed the row says so
 * instead of showing a confident wrong time.
 */
function ScheduleHeadlines({ cronJob }: { cronJob: CronJobDetailInfo }) {
  const lastAge = useRealtimeAge(cronJob.lastSchedule ?? null);
  const next = useMemo(
    () =>
      cronJob.suspend
        ? null
        : nextCronRun(cronJob.schedule, new Date(), cronJob.timezone),
    [cronJob.schedule, cronJob.timezone, cronJob.suspend]
  );
  const countdown = useRealtimeCountdown(next);
  const description = describeCron(cronJob.schedule);

  return (
    <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-3">
      <Headline
        label="Schedule"
        value={cronJob.schedule || "—"}
        mono
        note={
          <>
            {description ?? "cron expression"}
            {cronJob.timezone && ` · ${cronJob.timezone}`}
          </>
        }
      />
      <Headline
        label="Last run"
        value={cronJob.lastSchedule ? `${lastAge} ago` : "never"}
        note={
          cronJob.lastSuccessfulTime
            ? `last success ${formatDate(cronJob.lastSuccessfulTime)}`
            : cronJob.lastSchedule
              ? "no run has succeeded yet"
              : "this CronJob has not fired"
        }
        tone={
          cronJob.lastSchedule && !cronJob.lastSuccessfulTime
            ? "warn"
            : undefined
        }
      />
      <Headline
        label="Next run"
        value={
          cronJob.suspend
            ? "suspended"
            : next
              ? `in ${countdown.display}`
              : "unknown"
        }
        tone={cronJob.suspend ? "warn" : undefined}
        note={
          cronJob.suspend
            ? "nothing will start until the suspend flag is cleared"
            : next
              ? (formatDate(next.toISOString()) ?? undefined)
              : "the schedule could not be read"
        }
      />
    </div>
  );
}

export function CronJobDetail() {
  const {
    name,
    namespace,
    resource: cronJob,
    isLoading,
    error,
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

  const { data: jobs = [] } = useQuery({
    queryKey: ["cronjob-jobs", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
      try {
        const all = await commands.listJobs({
          namespace,
          labelSelector: null,
          fieldSelector: null,
          limit: null,
        });
        // The list command carries no owner references, so the naming
        // convention the controller uses is the only link available.
        return all.filter((job) => job.name.startsWith(`${name}-`));
      } catch {
        return [];
      }
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  // A CronJob's pods are two hops away — its runs own them — so they are
  // asked for only while the controller says a run is in flight. Between
  // runs there is nothing to list, and listing a namespace to find that out
  // is a fetch that answers a question already answered.
  const inFlight = (cronJob?.active ?? 0) > 0;

  const { data: pods = [] } = useQuery({
    queryKey: ["cronjob-pods", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
      try {
        const all = await commands.listPods({
          namespace,
          labelSelector: null,
          fieldSelector: null,
          limit: null,
          statusFilter: null,
          selector: null,
          nodeName: null,
        });
        return all.filter((pod) => matchCronJobPods({ name, namespace }, pod));
      } catch {
        return [];
      }
    },
    enabled: !!namespace && !!name && inFlight,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  const deliveryQuery = deliveryOfKind(ResourceType.CronJob, cronJob);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: "Overview",
        glyph: viewGlyph(Info),
        content: (
          <>
            <KeyValueSection
              title="Labels"
              count={Object.keys(cronJob?.labels ?? {}).length}
              items={recordToKeyValues(cronJob?.labels ?? {})}
              emptyMessage="No labels"
            />
            <KeyValueSection
              title="Annotations"
              count={Object.keys(cronJob?.annotations ?? {}).length}
              items={recordToKeyValues(cronJob?.annotations ?? {})}
              emptyMessage="No annotations"
            />
          </>
        ),
      },
      {
        id: "container-template",
        label: "Template",
        glyph: viewGlyph(Layers2),
        content: <ContainerRows template={cronJob} namespace={namespace} />,
      },
      {
        id: toPlural(ResourceType.Job),
        label: "Jobs",
        glyph: kindGlyph(ResourceType.Job),
        mark: countMark(jobs.length),
        content: (
          <Section>
            <SectionHeader
              title="Jobs"
              count={`${jobs.length} kept · history limits decide how many`}
            />
            <JobRows jobs={jobs} />
          </Section>
        ),
      },
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: "CronJob YAML",
        resourceKind: ResourceType.CronJob,
        resourceName: cronJob?.name || name || "",
        namespace: cronJob?.namespace || namespace,
      }),
    ],
    [cronJob, jobs, yaml, copyYaml, namespace, name]
  );

  if (!cronJob && !isLoading && !error) {
    return null;
  }

  const kept = {
    succeeded: cronJob?.successfulJobsHistoryLimit ?? 3,
    failed: cronJob?.failedJobsHistoryLimit ?? 1,
  };

  const policy: KeyValue[] = [
    {
      label: "Concurrency",
      value: cronJob?.concurrencyPolicy || "Allow",
    },
    {
      label: "Starting deadline",
      value: cronJob?.startingDeadlineSeconds
        ? `${cronJob.startingDeadlineSeconds}s`
        : // Without a deadline a run missed during controller downtime is
          // skipped silently rather than started late.
          "none — missed runs are skipped",
      mono: cronJob?.startingDeadlineSeconds != null,
    },
    serviceAccountRow(cronJob?.serviceAccountName, cronJob?.namespace),
  ];

  return (
    <ResourceDetailLayout
      resource={cronJob}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.CronJob}
      title={cronJob?.name || name || ""}
      namespace={cronJob?.namespace || namespace}
      createdAt={cronJob?.createdAt}
      statusBadge={
        cronJob && (
          <StatusBadge status={cronJob.suspend ? "Suspended" : "Active"} />
        )
      }
      onBack={goBack}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
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
    >
      {cronJob && <ScheduleHeadlines cronJob={cronJob} />}

      <WorkloadOverview
        count={
          <CountBlock
            title="Runs"
            // What decides how many a CronJob has is the schedule and the
            // history limits, and the schedule is already answered above the
            // fold by the three headlines — so this block counts what is
            // there and says what keeps it.
            subject="jobs this CronJob still owns"
          >
            <Composition
              total={jobs.length}
              label={jobs.length === 1 ? "job kept" : "jobs kept"}
              // Every segment is counted off the same list as the total, so the
              // bar cannot disagree with the rows under the Jobs tab.
              segments={[
                {
                  label: "running",
                  count: jobs.filter((job) => job.status === "Running").length,
                  tone: "ok",
                },
                {
                  label: "succeeded",
                  count: jobs.filter((job) => job.status === "Complete").length,
                  tone: "neutral",
                },
                {
                  label: "failed",
                  count: jobs.filter((job) => job.status === "Failed").length,
                  tone: "err",
                },
              ]}
              note={
                <>
                  {kept.succeeded} succeeded · {kept.failed} failed kept
                  {cronJob?.active
                    ? ` · ${cronJob.active} active per the controller`
                    : ""}
                </>
              }
            />
          </CountBlock>
        }
        usage={
          <WorkloadUsage
            kind={ResourceType.CronJob}
            uid={cronJob?.uid}
            name={cronJob?.name || name}
            namespace={cronJob?.namespace || namespace}
            template={cronJob}
            pods={pods}
            idle={
              cronJob?.suspend
                ? "This CronJob is suspended, so no run will start."
                : "No run of this CronJob is in flight."
            }
          />
        }
        declared={<FactBlock title="How it is declared" items={policy} />}
      >
        {cronJob && (
          <RelatedResources
            ownerReferences={cronJob.ownerReferences}
            namespace={cronJob.namespace}
          />
        )}
      </WorkloadOverview>
    </ResourceDetailLayout>
  );
}
