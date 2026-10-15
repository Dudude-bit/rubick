import { useCallback, useMemo, useState } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import {
  keepPreviousData,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useResourceWatch } from "@/hooks/useResourceWatch";
import { queryKeys } from "@/lib/query-keys";
import { useSurfaceVisible } from "@/lib/surface-visibility";
import { useClusterStore } from "@/stores/clusterStore";
import { AlignLeft, Info, Layers2, Play } from "lucide-react";

import { LogViewer } from "../../../-logs/LogViewer";
import { lanePodOf } from "../../../-logs/lanes";
import { Section, SectionHeader } from "@/components/ui/section";
import { CronStatusBadge } from "./CronStatusBadge";
import { cronOutcome, outcomeWords } from "@/lib/cron-outcome";
import {
  cronJobRunsKey,
  lastRunRefused,
  useCronJobRuns,
} from "../../../-peek/cron-runs";
import { LastRunCause } from "../../../-peek/peek-workload-diagnosis";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Unknown } from "@/components/ui/unknown";
import { useToast } from "@/components/ui/use-toast";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { RelatedResources } from "../../-components/RelatedResources";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import {
  readCountMark,
  kindGlyph,
  viewGlyph,
} from "@/components/object/detail-tab";
import { ContainerRows } from "../../../-object/container-rows";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "../../../-delivery/delivery-intercept";
import { guardedOf, noteDenied, useDeniedOf } from "@/lib/access";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { JobRows } from "../../../-object/child-rows";
import { describeCron, nextCronRun } from "./cron-schedule";
import { Composition, Headline } from "@/components/object/detail-blocks";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "../../-components/workload-overview";
import { AlertsAbout } from "../../../-object/AlertsAbout";
import { serviceAccountRow } from "../../-components/identity-rows";
import { WorkloadUsage } from "../../-components/workload-usage";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { PinAction } from "../../-components/PinAction";
import { useResourceDetail } from "@/hooks";
import { useCronJobShare } from "./useCronJobShare";
import { useRealtimeAge, useRealtimeCountdown } from "@/hooks/useRealtimeAge";
import { commands } from "@/lib/commands";
import { matchCronJobPods } from "@/lib/metrics";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { formatDate, formatTimeUnit } from "@/lib/utils";
import type { CronJobDetailInfo, JobInfo } from "@/generated/types";
import type { CompositionTone } from "@/components/object/detail-blocks";
import { useRefusals } from "@/hooks/useRefusals";
import { toldRuns } from "@/lib/create-refusal";
import type { JobStatus } from "@/lib/status-meaning";
import { useT } from "@/i18n/useT";
import { toastError } from "@/lib/toast-error";
import { None } from "@/components/ui/none";

/**
 * The three facts a CronJob page exists to answer, at a glance.
 *
 * Kubernetes reports neither the next fire time nor a readable schedule, so
 * both are derived here; when the expression cannot be parsed the row says so
 * instead of showing a confident wrong time.
 */
function ScheduleHeadlines({
  cronJob,
  lastRun,
  running,
  refused,
}: {
  cronJob: CronJobDetailInfo;
  /** When it last fired, by its own status or by the newest run it holds, whichever is later. */
  lastRun: string | null;
  /** A run it holds is in flight, whatever its status has caught up with. */
  running: boolean;
  /** The API server refuses its newest run's pods. */
  refused: boolean;
}) {
  const t = useT();
  const lastAge = useRealtimeAge(lastRun);
  // Every render, deliberately, where this was a `useMemo` keyed on the
  // schedule string. The countdown below re-renders this component once a
  // second; a next-run computed once at mount counts down to zero and stays
  // there, so the page read «через expired» above a time that had already
  // passed, for as long as it stayed open. One cron parse a second on one
  // page is the whole cost of it being true instead.
  const next = cronJob.suspend
    ? null
    : nextCronRun(cronJob.schedule, new Date(), cronJob.timezone);
  const countdown = useRealtimeCountdown(next);
  const description = describeCron(cronJob.schedule, t);

  return (
    <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-3">
      <Headline
        label={t("columns", "schedule")}
        value={cronJob.schedule || <None />}
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
          lastRun
            ? t("action", "agoSuffix", { age: lastAge })
            : t("action", "never")
        }
        note={
          cronJob.lastSuccessfulTime
            ? t("action", "lastSuccessAt", {
                when: formatDate(cronJob.lastSuccessfulTime) ?? "",
              })
            : lastRun
              ? t("action", "noRunSucceededYet")
              : t("action", "cronJobNeverFired")
        }
        tone={
          outcomeWords(
            cronOutcome(
              {
                active: running ? 1 : cronJob.active,
                lastSchedule: lastRun,
                lastSuccessfulTime: cronJob.lastSuccessfulTime,
              },
              refused
            ),
            t
          ).tone ?? undefined
        }
      />
      <Headline
        label={t("columns", "nextRun")}
        value={
          cronJob.suspend
            ? t("action", "suspendedLower")
            : next
              ? countdown.display
                ? t("action", "inTime", { time: countdown.display })
                : t("action", "nowLower")
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

/**
 * The later of the CronJob's own last schedule and the newest run it holds.
 * The controller names a scheduled Job after the minute it was scheduled
 * for, so a Job the page has seen dates the run before the CronJob's status
 * is read again.
 */
function lastRunOf(
  name: string,
  lastSchedule: string | null,
  jobs: readonly JobInfo[]
): string | null {
  const prefix = `${name}-`;
  const minutes = jobs.map((job) => {
    const suffix = job.name.startsWith(prefix)
      ? job.name.slice(prefix.length)
      : "";
    return /^\d+$/.test(suffix) ? Number(suffix) : 0;
  });
  const newest = Math.max(0, ...minutes) * 60_000;
  const said = lastSchedule ? Date.parse(lastSchedule) : 0;
  return newest > said ? new Date(newest).toISOString() : lastSchedule;
}

const NO_JOBS: JobInfo[] = [];

/**
 * The namespace's Jobs, watched while the page is shown: a change to one of
 * this CronJob's runs reads its runs, their pods and the CronJob again, so
 * a run starting or ending moves "Last run", the runs and Usage together
 * rather than on three polls that back off apart.
 */
function useRunsWatch(namespace: string | undefined, name: string | undefined) {
  const connected = useClusterStore((s) => s.isConnected);
  const visible = useSurfaceVisible();
  const queryKey = useMemo(
    () => ["cronjob-runs-watch", namespace, name],
    [namespace, name]
  );
  const subscribe = useCallback(
    () => commands.subscribeJobWatch(namespace ? [namespace] : null),
    [namespace]
  );
  const reads = useMemo(
    () => [
      cronJobRunsKey(namespace, name),
      ["cronjob-pods", namespace, name],
      queryKeys.detail(ResourceType.CronJob, namespace, name),
    ],
    [namespace, name]
  );
  useResourceWatch<JobInfo>({
    enabled: connected && visible && !!namespace && !!name,
    subscribe,
    queryKey,
    detail: (job) => (job.name.startsWith(`${name}-`) ? reads : []),
    recount: false,
    behind: true,
  });
}
const RUNS_IN_FLIGHT = new Set(["Running", "Retrying", "Pending"]);

/** Every word a run can carry, so no run kept is left out of the bar. */
const RUN_SEGMENT: Record<
  JobStatus,
  {
    key:
      | "runningSegment"
      | "jobsSucceededSegment"
      | "retryingSegment"
      | "jobsFailedSegment"
      | "jobsRefusedSegment"
      | "jobsNotStartedSegment"
      | "jobsSuspendedSegment";
    tone: CompositionTone;
  }
> = {
  Running: { key: "runningSegment", tone: "ok" },
  Complete: { key: "jobsSucceededSegment", tone: "neutral" },
  Retrying: { key: "retryingSegment", tone: "warn" },
  Failed: { key: "jobsFailedSegment", tone: "err" },
  FailedCreate: { key: "jobsRefusedSegment", tone: "err" },
  Pending: { key: "jobsNotStartedSegment", tone: "pending" },
  Suspended: { key: "jobsSuspendedSegment", tone: "neutral" },
};

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
  const runs = guardedOf(ResourceType.Job, namespace || null);
  const [runDenied] = useDeniedOf([runs && { ...runs, verb: "create" }]);
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
      void queryClient.invalidateQueries({
        queryKey: cronJobRunsKey(namespace, name),
      });
      setRunOpen(false);
    },
    onError: (error: Error) => {
      noteDenied("create", runs, error);
      toastError(t("action", "cronRunFailed"), error);
    },
  });

  // A refused list is carried, not read as "no runs": the peek already
  // said "could not read this CronJob's runs" beside a page claiming none.
  const {
    data: jobsRead,
    error: jobsError,
    refetch: refetchJobs,
  } = useCronJobRuns(namespace, name);
  const jobs = jobsRead ?? NO_JOBS;
  useRunsWatch(namespace, name);
  const refusals = useRefusals(
    namespace ?? null,
    jobs.some((job) => job.status === "Pending")
  );
  const told = useMemo(() => toldRuns(jobs, refusals), [jobs, refusals]);
  const tally = useMemo(
    () =>
      (Object.keys(RUN_SEGMENT) as JobStatus[]).map((status) => ({
        status,
        count: told.filter((run) => run.status === status).length,
      })),
    [told]
  );

  // A CronJob's pods are two hops away, owned by its runs, so they are asked
  // for only while the controller or a Job held here says a run is in flight.
  // Between runs there is nothing to list, and that is already an answer.
  const inFlight =
    (cronJob?.active ?? 0) > 0 ||
    jobs.some((job) => RUNS_IN_FLIGHT.has(job.status));

  // The refusal is carried rather than swallowed: an empty list from a 403
  // reads as "this CronJob has run nothing", which is the one thing the pane
  // may not say on a read that did not happen.
  const {
    data: pods = [],
    error: podsError,
    isPending: podsPending,
  } = useLiveQuery({
    queryKey: ["cronjob-pods", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
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
    },
    enabled: !!namespace && !!name && inFlight,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });

  const deliveryQuery = deliveryOfKind(ResourceType.CronJob, cronJob);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const events = useObjectEvents(ResourceType.CronJob, name, namespace, {
    refresh: "slow",
  });

  const share = useCronJobShare(cronJob, told, jobsError);

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: t("nav", "overview"),
        glyph: viewGlyph(Info),
        content: (
          <>
            {cronJob && (
              <ScheduleHeadlines
                cronJob={cronJob}
                lastRun={lastRunOf(cronJob.name, cronJob.lastSchedule, jobs)}
                running={inFlight}
                refused={lastRunRefused(told)}
              />
            )}

            <WorkloadOverview
              alerts={
                <AlertsAbout
                  kind={ResourceType.CronJob}
                  name={name ?? ""}
                  namespace={namespace ?? null}
                />
              }
              count={
                <CountBlock
                  title={t("action", "runs")}
                  // What decides how many a CronJob has is the schedule and the
                  // history limits, and the schedule is already answered by the
                  // three headlines above — so this block counts what is there
                  // and says what keeps it.
                  subject={t("action", "runsSubject")}
                >
                  {jobsError ? (
                    <Unknown
                      question={t("empty", "couldNotReadCronJobRuns")}
                      error={jobsError}
                      onRetry={() => void refetchJobs()}
                    />
                  ) : (
                    <Composition
                      total={jobs.length}
                      label={t("count", "jobsKept", { n: jobs.length })}
                      // Every segment is counted off the same list as the total,
                      // so the bar cannot disagree with the rows under the Jobs
                      // tab.
                      segments={tally.map(({ status, count }) => ({
                        label: t("count", RUN_SEGMENT[status].key, {
                          n: count,
                        }),
                        count,
                        tone: RUN_SEGMENT[status].tone,
                      }))}
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
                  )}
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
                  podsError={podsError}
                  podsPending={inFlight ? podsPending : !cronJob}
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
        mark: jobsError
          ? readCountMark(null, t("empty", "couldNotReadCronJobRuns"))
          : readCountMark(jobsRead ? jobsRead.length : null, null),
        content: (
          <Section>
            <SectionHeader
              title="Jobs"
              count={
                jobsError
                  ? undefined
                  : t("action", "keptHistoryLimits", { n: jobs.length })
              }
            />
            {jobsError ? (
              <Unknown
                question={t("empty", "couldNotReadCronJobRuns")}
                error={jobsError}
                onRetry={() => void refetchJobs()}
              />
            ) : (
              <JobRows jobs={told} />
            )}
          </Section>
        ),
      },
      {
        id: "logs",
        label: t("action", "logs"),
        glyph: viewGlyph(AlignLeft),
        kind: "surface" as const,
        content: (
          <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1">
              <LogViewer
                key={`${namespace}/${name}`}
                namespace={namespace || ""}
                pods={pods.map(lanePodOf)}
                podsError={podsError}
                laneRule="run"
                workload={name ? { owner: name, ownerKind: "CronJob" } : null}
                idle={
                  cronJob
                    ? cronJob.suspend
                      ? t("empty", "cronJobSuspended")
                      : t("empty", "cronJobNoRunInFlight")
                    : null
                }
              />
            </div>
          </div>
        ),
      },
      eventsTab(events, t, { kind: ResourceType.CronJob, name: name ?? "" }),
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: t("action", "kindYaml", { kind: "CronJob" }),
        resourceKind: ResourceType.CronJob,
        resourceName: cronJob?.name || name || "",
        namespace: cronJob?.namespace || namespace,
      }),
    ],
    [
      events,
      cronJob,
      jobs,
      told,
      tally,
      jobsRead,
      jobsError,
      refetchJobs,
      pods,
      podsError,
      podsPending,
      inFlight,
      yaml,
      copyYaml,
      namespace,
      name,
      t,
    ]
  );

  return (
    <>
      <ResourceDetailLayout
        freshness={freshness}
        resource={cronJob}
        delivery={deliveryQuery}
        share={share}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.CronJob}
        title={cronJob?.name || name || ""}
        namespace={cronJob?.namespace || namespace}
        createdAt={cronJob?.createdAt}
        statusBadge={cronJob && <CronStatusBadge suspend={cronJob.suspend} />}
        summary={
          cronJob && (
            <LastRunCause namespace={cronJob.namespace} name={cronJob.name} />
          )
        }
        onBack={goBack}
        actions={
          <>
            <PinAction kind="CronJob" namespace={namespace} name={name} />
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
              reason={runDenied}
            />
            <DeleteAction
              kind={ResourceType.CronJob}
              name={cronJob?.name || name || ""}
              namespace={cronJob?.namespace || namespace}
              detail={cronJob}
              intercept={intercept("Delete")}
              mutation={deleteMutation}
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
      value:
        cronJob?.startingDeadlineSeconds != null
          ? formatTimeUnit(cronJob.startingDeadlineSeconds, "second")
          : t("action", "noStartingDeadline"),
      mono: cronJob?.startingDeadlineSeconds != null,
    },
    serviceAccountRow(cronJob?.serviceAccountName, cronJob?.namespace, t),
  ];
}
