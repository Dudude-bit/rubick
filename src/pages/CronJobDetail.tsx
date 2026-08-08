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
import { JobRows } from "@/components/resources/child-rows";
import {
  describeCron,
  nextCronRun,
} from "@/components/resources/cron-schedule";
import {
  Composition,
  DetailAction,
  Headline,
} from "@/components/resources/detail-blocks";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useRealtimeAge, useRealtimeCountdown } from "@/hooks/useRealtimeAge";
import { commands } from "@/lib/commands";
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
        content: (
          <ContainerRows
            containers={cronJob?.containers ?? []}
            namespace={namespace}
          />
        ),
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
    {
      label: "History kept",
      value: `${kept.succeeded} succeeded · ${kept.failed} failed`,
    },
    {
      label: "Containers",
      value: cronJob?.containers.length ?? 0,
      mono: true,
    },
  ];

  return (
    <ResourceDetailLayout
      resource={cronJob}
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
    >
      {cronJob && <ScheduleHeadlines cronJob={cronJob} />}

      <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
        <Section>
          <SectionHeader title="Runs" count="jobs this CronJob still owns" />
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
              cronJob?.active
                ? `${cronJob.active} active per the controller`
                : undefined
            }
          />
        </Section>
        <KeyValueSection title="Policy" items={policy} />
      </div>

      {cronJob && (
        <RelatedResources
          ownerReferences={cronJob.ownerReferences}
          namespace={cronJob.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
