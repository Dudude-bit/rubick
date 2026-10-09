import { useCallback, useMemo } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { AlignLeft, BadgeCheck, Info, Layers2 } from "lucide-react";

import { LogViewer } from "../../../-logs/LogViewer";
import { lanePodOf } from "../../../-logs/lanes";
import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { RelatedResources } from "../../-components/RelatedResources";
import { PodListCard } from "../../../-object/PodListCard";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import {
  conditionsMark,
  kindGlyph,
  podsMark,
  viewGlyph,
} from "@/components/object/detail-tab";
import { ContainerRows } from "../../../-object/container-rows";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "../../-components/workload-overview";
import { AlertsAbout } from "../../../-object/AlertsAbout";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { Composition, ConditionRows } from "@/components/object/detail-blocks";
import { serviceAccountRow } from "../../-components/identity-rows";
import { WorkloadUsage } from "../../-components/workload-usage";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { useResourceDetail } from "@/hooks";
import { useJobShare } from "./useJobShare";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useOwnedPodsWatch } from "@/hooks/usePodWatch";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";
import { jobEndRow, jobRanFor } from "../../../-object/job-end";
import type { JobDetailInfo, PodInfo } from "@/generated/types";
import { controlledBy } from "@/lib/controlled-by";
import { useT } from "@/i18n/useT";
import { ownStatusWord } from "@/lib/status-words";

export function JobDetail() {
  const t = useT();
  const {
    name,
    namespace,
    resource: job,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
    freshness,
  } = useResourceDetail<JobDetailInfo>({
    resourceKind: ResourceType.Job,
    fetchResource: (name, ns) => commands.getJob(name, ns),
    deleteResource: (name, ns) => commands.deleteJob(name, ns),
    defaultTab: "overview",
  });

  const podsKey = queryKeys.ownedPods(ResourceType.Job, namespace, name);
  // The refusal is carried rather than swallowed: an empty list from a 403
  // reads as "this Job ran no pods", which is the one thing the pane may not
  // say on a read that did not happen.
  const {
    data: pods = [],
    error: podsError,
    isPending: podsPending,
  } = useLiveQuery({
    queryKey: podsKey,
    queryFn: async () => {
      if (!name || !namespace) return [];
      return await commands.listPods({
        namespace,
        labelSelector: `job-name=${name}`,
        fieldSelector: null,
        limit: null,
        statusFilter: null,
        selector: null,
        nodeName: null,
      });
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
    select: useCallback(
      (pods: PodInfo[]) => controlledBy(pods, job?.uid),
      [job?.uid]
    ),
  });
  useOwnedPodsWatch(ResourceType.Job, namespace, name, [podsKey], !!job);

  const deliveryQuery = deliveryOfKind(ResourceType.Job, job);
  const intercept = useDeliveryIntercept(deliveryQuery);

  // An unset `completions` means the job is done after one successful pod.
  const completions = job?.completions ?? 1;
  const parallelism = job?.parallelism ?? 1;
  const backoffLimit = job?.backoffLimit ?? 6;
  const succeeded = job?.succeeded ?? 0;
  const failed = job?.failed ?? 0;
  const active = job?.active ?? 0;

  const events = useObjectEvents(ResourceType.Job, name, namespace, {
    refresh: "slow",
  });

  const share = useJobShare(job, pods, podsError);

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: t("nav", "overview"),
        glyph: viewGlyph(Info),
        content: (
          <>
            <WorkloadOverview
              alerts={
                <AlertsAbout
                  kind={ResourceType.Job}
                  name={name ?? ""}
                  namespace={namespace ?? null}
                />
              }
              count={
                <CountBlock
                  title={t("action", "run")}
                  // A Job counts completions rather than replicas, and what
                  // decides the number is the spec rather than an autoscaler:
                  // parallelism and the backoff limit are the same setting read
                  // two more ways, so they qualify the count under the bar
                  // instead of standing as rows beside it.
                  subject={t("action", "runSubject")}
                >
                  <Composition
                    total={completions}
                    label={
                      job?.completions == null
                        ? t("action", "successfulPodNeeded")
                        : t("count", "completionsWanted", { n: completions })
                    }
                    segments={[
                      {
                        label: t("count", "succeededSegment"),
                        count: succeeded,
                        tone: "neutral",
                      },
                      {
                        label: t("count", "runningSegment"),
                        count: active,
                        tone: "ok",
                      },
                      {
                        label: t("count", "failedSegment"),
                        count: failed,
                        tone: "err",
                      },
                    ]}
                    note={
                      <>
                        {t("action", "atATime", { n: parallelism })} ·{" "}
                        {t("action", "upTo")} {backoffLimit}{" "}
                        {t("count", "retryNoun", { n: backoffLimit })}
                        {succeeded < completions &&
                          active === 0 &&
                          failed > 0 && (
                            <> · {t("action", "noPodRunningLastFailed")}</>
                          )}
                      </>
                    }
                  />
                </CountBlock>
              }
              usage={
                <WorkloadUsage
                  kind={ResourceType.Job}
                  uid={job?.uid}
                  name={job?.name || name}
                  namespace={job?.namespace || namespace}
                  template={job}
                  pods={pods}
                  podsError={podsError}
                  podsPending={podsPending}
                  idle={
                    job?.completionTime
                      ? t("empty", "jobFinished")
                      : failed > 0
                        ? t("empty", "jobNoPodRunningFailed")
                        : t("empty", "jobNoPodRunning")
                  }
                />
              }
              declared={
                <FactBlock
                  title={t("action", "timing")}
                  items={timing(job, t)}
                />
              }
            >
              {job && (
                <RelatedResources
                  ownerReferences={job.ownerReferences}
                  namespace={job.namespace}
                />
              )}
            </WorkloadOverview>

            <KeyValueSection
              title={t("columns", "labels")}
              count={Object.keys(job?.labels ?? {}).length}
              items={recordToKeyValues(job?.labels ?? {})}
              emptyMessage={t("empty", "noLabels")}
            />
            <KeyValueSection
              title={t("columns", "annotations")}
              count={Object.keys(job?.annotations ?? {}).length}
              items={recordToKeyValues(job?.annotations ?? {})}
              emptyMessage={t("empty", "noAnnotations")}
            />
          </>
        ),
      },
      {
        id: "container-template",
        label: t("columns", "template"),
        glyph: viewGlyph(Layers2),
        content: <ContainerRows template={job} namespace={namespace} />,
      },
      {
        id: toPlural(ResourceType.Pod),
        label: t("columns", "pods"),
        glyph: kindGlyph(ResourceType.Pod),
        mark: podsMark(pods, t, { error: podsError, pending: podsPending }),
        content: (
          <PodListCard
            pods={pods}
            error={podsError}
            emptyMessage={t("empty", "noPodsForJob")}
          />
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
                laneRule="pod"
                workload={name ? { owner: name, ownerKind: "Job" } : null}
                idle={job?.completionTime ? t("empty", "jobFinished") : null}
              />
            </div>
          </div>
        ),
      },
      {
        id: "conditions",
        label: t("nav", "conditions"),
        glyph: viewGlyph(BadgeCheck),
        mark: conditionsMark(job?.conditions, t),
        content: (
          <Section>
            <SectionHeader
              title={t("nav", "conditions")}
              count={job?.conditions.length}
            />
            <ConditionRows
              conditions={job?.conditions ?? []}
              subject={{ kind: ResourceType.Job, name, namespace }}
            />
          </Section>
        ),
      },
      eventsTab(events, t, { kind: ResourceType.Job, name: name ?? "" }),
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: t("action", "kindYaml", { kind: "Job" }),
        resourceKind: ResourceType.Job,
        resourceName: job?.name || name || "",
        namespace: job?.namespace || namespace,
      }),
    ],
    [
      events,
      t,
      job,
      pods,
      podsError,
      podsPending,
      yaml,
      copyYaml,
      namespace,
      name,
      completions,
      parallelism,
      backoffLimit,
      succeeded,
      failed,
      active,
    ]
  );

  if (!job && !isLoading && !error) {
    return null;
  }

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={job}
      delivery={deliveryQuery}
      share={share}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Job}
      title={job?.name || name || ""}
      namespace={job?.namespace || namespace}
      createdAt={job?.createdAt}
      statusBadge={
        job && (
          <StatusBadge status={job.status}>
            {ownStatusWord(job.status, t)}
          </StatusBadge>
        )
      }
      badges={
        job?.failure?.reason ? (
          <span className="font-mono text-[11px] text-err">
            {job.failure.reason}
          </span>
        ) : (
          failed > 0 && (
            // A failed pod the Job is still retrying is a warning; only the
            // controller's Failed condition is a failure.
            <span className="text-[11px] text-warn">
              {t("count", "failedPods", { n: failed })}
            </span>
          )
        )
      }
      onBack={goBack}
      actions={
        <DeleteAction
          kind={ResourceType.Job}
          name={job?.name || name || ""}
          namespace={job?.namespace || namespace}
          detail={job}
          intercept={intercept("Delete")}
          mutation={deleteMutation}
        />
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    />
  );
}

/** When it started, when it stopped, and what it runs as. */
function timing(
  job: JobDetailInfo | undefined,
  t: ReturnType<typeof useT>
): KeyValue[] {
  const ran = job ? jobRanFor(job, Date.now()) : null;
  const end = job ? jobEndRow(job, t) : null;

  return [
    {
      label: t("action", "started"),
      value: job?.startTime
        ? formatDate(job.startTime)
        : t("action", "notStarted"),
      tone: job?.startTime ? undefined : "warn",
    },
    ...(end ? [end] : []),
    ...(ran ? [{ label: t("action", "ranFor"), value: ran, mono: true }] : []),
    ...(job?.activeDeadlineSeconds
      ? [
          {
            label: t("action", "deadline"),
            value: t("action", "afterStart", { n: job.activeDeadlineSeconds }),
            mono: true,
          },
        ]
      : []),
    serviceAccountRow(job?.serviceAccountName, job?.namespace, t),
  ];
}
