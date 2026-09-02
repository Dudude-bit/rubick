import { useMemo, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { Info, Layers2, Play, Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";
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
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";
import type { CronJobDetailInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

/**
 * The three facts a CronJob page exists to answer, at a glance.
 *
 * Kubernetes reports neither the next fire time nor a readable schedule, so
 * both are derived here; when the expression cannot be parsed the row says so
 * instead of showing a confident wrong time.
 */
function ScheduleHeadlines({ cronJob }: { cronJob: CronJobDetailInfo }) {
  const t = useT();
  const lastAge = useRealtimeAge(cronJob.lastSchedule ?? null);
  const next = useMemo(
    () =>
      cronJob.suspend
        ? null
        : nextCronRun(cronJob.schedule, new Date(), cronJob.timezone),
    [cronJob.schedule, cronJob.timezone, cronJob.suspend]
  );
  const countdown = useRealtimeCountdown(next);
  const description = describeCron(cronJob.schedule, t);

  return (
    <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-3">
      <Headline
        label={t("columns", "schedule")}
        value={cronJob.schedule || "—"}
        mono
        note={
          <>
            {description ?? t("action", "cronExpression")}
            {cronJob.timezone && ` · ${cronJob.timezone}`}
          </>
        }
      />
      <Headline
        label={t("columns", "lastRun")}
        value={
          cronJob.lastSchedule
            ? t("action", "agoSuffix", { age: lastAge })
            : t("action", "never")
        }
        note={
          cronJob.lastSuccessfulTime
            ? t("action", "lastSuccessAt", {
                when: formatDate(cronJob.lastSuccessfulTime) ?? "",
              })
            : cronJob.lastSchedule
              ? t("action", "noRunSucceededYet")
              : t("action", "cronJobNeverFired")
        }
        tone={
          cronJob.lastSchedule && !cronJob.lastSuccessfulTime
            ? "warn"
            : undefined
        }
      />
      <Headline
        label={t("columns", "nextRun")}
        value={
          cronJob.suspend
            ? t("action", "suspendedLower")
            : next
              ? t("action", "inTime", { time: countdown.display })
              : t("action", "unknownLower")
        }
        tone={cronJob.suspend ? "warn" : undefined}
        note={
          cronJob.suspend
            ? t("action", "suspendFlagNote")
            : next
              ? (formatDate(next.toISOString()) ?? undefined)
              : t("action", "scheduleUnreadable")
        }
      />
    </div>
  );
}

export function CronJobDetail() {
  const t = useT();
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
    freshness,
  } = useResourceDetail<CronJobDetailInfo>({
    resourceKind: ResourceType.CronJob,
    fetchResource: (name, ns) => commands.getCronjob(name, ns),
    deleteResource: (name, ns) => commands.deleteCronjob(name, ns),
    defaultTab: "overview",
  });

  // Run now. A CronJob has no "run" verb — what `kubectl create job --from`
  // does is copy the jobTemplate into a new Job, which is what the backend
  // does here. The name is offered rather than imposed: a person who presses
  // this weekly wants to find their run again in a list of forty.
  const [runOpen, setRunOpen] = useState(false);
  const [runName, setRunName] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const runMutation = useMutation({
    mutationFn: () =>
      commands.triggerCronjob(name || "", runName, namespace || null),
    onSuccess: (created) => {
      toast({
        title: t("action", "cronRunStarted"),
        description: t("action", "cronRunStartedName", { name: created }),
      });
      queryClient.invalidateQueries({
        queryKey: ["cronjob-jobs", namespace, name],
      });
      setRunOpen(false);
    },
    onError: (error: Error) => {
      toast({
        title: t("action", "cronRunFailed"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const { data: jobs = [] } = useLiveQuery({
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
    refresh: "resourceList",
  });

  // A CronJob's pods are two hops away — its runs own them — so they are
  // asked for only while the controller says a run is in flight. Between
  // runs there is nothing to list, and listing a namespace to find that out
  // is a fetch that answers a question already answered.
  const inFlight = (cronJob?.active ?? 0) > 0;

  const { data: pods = [] } = useLiveQuery({
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
    refresh: "resourceList",
  });

  const deliveryQuery = deliveryOfKind(ResourceType.CronJob, cronJob);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: t("nav", "overview"),
        glyph: viewGlyph(Info),
        content: (
          <>
            {cronJob && <ScheduleHeadlines cronJob={cronJob} />}

            <WorkloadOverview
              count={
                <CountBlock
                  title={t("action", "runs")}
                  // What decides how many a CronJob has is the schedule and the
                  // history limits, and the schedule is already answered by the
                  // three headlines above — so this block counts what is there
                  // and says what keeps it.
                  subject={t("action", "runsSubject")}
                >
                  <Composition
                    total={jobs.length}
                    label={t("count", "jobsKept", { n: jobs.length })}
                    // Every segment is counted off the same list as the total,
                    // so the bar cannot disagree with the rows under the Jobs
                    // tab.
                    segments={[
                      {
                        label: t("count", "runningSegment"),
                        count: jobs.filter((job) => job.status === "Running")
                          .length,
                        tone: "ok",
                      },
                      {
                        label: t("count", "succeededSegment"),
                        count: jobs.filter((job) => job.status === "Complete")
                          .length,
                        tone: "neutral",
                      },
                      {
                        label: t("count", "failedSegment"),
                        count: jobs.filter((job) => job.status === "Failed")
                          .length,
                        tone: "err",
                      },
                    ]}
                    note={
                      <>
                        {t("action", "historyLimits", {
                          succeeded: cronJob?.successfulJobsHistoryLimit ?? 3,
                          failed: cronJob?.failedJobsHistoryLimit ?? 1,
                        })}
                        {cronJob?.active
                          ? ` · ${t("action", "activePerController", {
                              n: cronJob.active,
                            })}`
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
                      ? t("empty", "cronJobSuspended")
                      : t("empty", "cronJobNoRunInFlight")
                  }
                />
              }
              declared={
                <FactBlock
                  title={t("action", "howDeclared")}
                  items={policy(cronJob, t)}
                />
              }
            >
              {cronJob && (
                <RelatedResources
                  ownerReferences={cronJob.ownerReferences}
                  namespace={cronJob.namespace}
                />
              )}
            </WorkloadOverview>

            <KeyValueSection
              title={t("columns", "labels")}
              count={Object.keys(cronJob?.labels ?? {}).length}
              items={recordToKeyValues(cronJob?.labels ?? {})}
              emptyMessage={t("empty", "noLabels")}
            />
            <KeyValueSection
              title={t("columns", "annotations")}
              count={Object.keys(cronJob?.annotations ?? {}).length}
              items={recordToKeyValues(cronJob?.annotations ?? {})}
              emptyMessage={t("empty", "noAnnotations")}
            />
          </>
        ),
      },
      {
        id: "container-template",
        label: t("columns", "template"),
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
              count={t("action", "keptHistoryLimits", { n: jobs.length })}
            />
            <JobRows jobs={jobs} />
          </Section>
        ),
      },
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: t("action", "kindYaml", { kind: "CronJob" }),
        resourceKind: ResourceType.CronJob,
        resourceName: cronJob?.name || name || "",
        namespace: cronJob?.namespace || namespace,
      }),
    ],
    [cronJob, jobs, pods, yaml, copyYaml, namespace, name, t]
  );

  if (!cronJob && !isLoading && !error) {
    return null;
  }

  return (
    <>
      <ResourceDetailLayout
        freshness={freshness}
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
          <>
            <InterceptedAction
              intercept={intercept("Run")}
              label={t("action", "runNow")}
              icon={Play}
              onClick={() => {
                // Offered, not imposed — and unique, because two runs in one
                // minute are a normal thing to want.
                setRunName(`${name}-${Math.floor(Date.now() / 1000)}`);
                setRunOpen(true);
              }}
              busy={runMutation.isPending}
            />
            <InterceptedAction
              intercept={intercept("Delete")}
              label={t("action", "delete")}
              icon={Trash2}
              onClick={() => deleteMutation?.mutate()}
              busy={deleteMutation?.isPending}
              danger
            />
          </>
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <ConfirmDialog
        open={runOpen}
        onOpenChange={setRunOpen}
        title={t("action", "runNowTitle")}
        description={t("action", "runNowBody", { name: name ?? "" })}
        confirmLabel={t("action", "runNow")}
        confirmDisabled={runName.trim() === "" || runMutation.isPending}
        onConfirm={() => runMutation.mutate()}
      >
        <Input
          value={runName}
          onChange={(event) => setRunName(event.target.value)}
          aria-label={t("action", "runNowName")}
          className="font-mono"
        />
      </ConfirmDialog>
    </>
  );
}

/** How it is declared: the settings that decide what a missed or overlapping
 *  run does, which nobody reads until one has happened. */
function policy(
  cronJob: CronJobDetailInfo | undefined,
  t: ReturnType<typeof useT>
): KeyValue[] {
  return [
    {
      label: t("action", "concurrency"),
      value: cronJob?.concurrencyPolicy || "Allow",
    },
    {
      label: t("action", "startingDeadline"),
      value: cronJob?.startingDeadlineSeconds
        ? `${cronJob.startingDeadlineSeconds}s`
        : // Without a deadline a run missed during controller downtime is
          // skipped silently rather than started late.
          t("action", "noStartingDeadline"),
      mono: cronJob?.startingDeadlineSeconds != null,
    },
    serviceAccountRow(cronJob?.serviceAccountName, cronJob?.namespace, t),
  ];
}
