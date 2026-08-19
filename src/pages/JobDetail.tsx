import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { BadgeCheck, Info, Layers2, Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { PodListCard } from "@/components/resources/PodListCard";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  conditionsMark,
  kindGlyph,
  podsMark,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { ContainerRows } from "@/components/resources/container-rows";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "@/components/resources/workload-overview";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import {
  Composition,
  ConditionRows,
} from "@/components/resources/detail-blocks";
import { serviceAccountRow } from "@/components/resources/identity-rows";
import { WorkloadUsage } from "@/components/resources/workload-usage";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";
import type { JobDetailInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

/** Wall-clock time the job has been running, or ran for. */
function duration(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const from = new Date(start).getTime();
  const to = end ? new Date(end).getTime() : Date.now();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;

  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

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

  const { data: pods = [] } = useLiveQuery({
    queryKey: ["job-pods", namespace, name],
    queryFn: async () => {
      if (!name || !namespace) return [];
      try {
        return await commands.listPods({
          namespace,
          labelSelector: `job-name=${name}`,
          fieldSelector: null,
          limit: null,
          statusFilter: null,
          selector: null,
          nodeName: null,
        });
      } catch {
        return [];
      }
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });

  const deliveryQuery = deliveryOfKind(ResourceType.Job, job);
  const intercept = useDeliveryIntercept(deliveryQuery);

  // An unset `completions` means the job is done after one successful pod.
  const completions = job?.completions ?? 1;
  const parallelism = job?.parallelism ?? 1;
  const backoffLimit = job?.backoffLimit ?? 6;
  const succeeded = job?.succeeded ?? 0;
  const failed = job?.failed ?? 0;
  const active = job?.active ?? 0;

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: t("nav", "overview"),
        glyph: viewGlyph(Info),
        content: (
          <>
            <WorkloadOverview
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
                      { label: "succeeded", count: succeeded, tone: "neutral" },
                      { label: "running", count: active, tone: "ok" },
                      { label: "failed", count: failed, tone: "err" },
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
        label: "Pods",
        glyph: kindGlyph(ResourceType.Pod),
        mark: podsMark(pods),
        content: (
          <PodListCard pods={pods} emptyMessage={t("empty", "noPodsForJob")} />
        ),
      },
      {
        id: "conditions",
        label: "Conditions",
        glyph: viewGlyph(BadgeCheck),
        mark: conditionsMark(job?.conditions),
        content: (
          <Section>
            <SectionHeader title="Conditions" count={job?.conditions.length} />
            <ConditionRows
              conditions={job?.conditions ?? []}
              subject={{ kind: ResourceType.Job, name, namespace }}
            />
          </Section>
        ),
      },
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: "Job YAML",
        resourceKind: ResourceType.Job,
        resourceName: job?.name || name || "",
        namespace: job?.namespace || namespace,
      }),
    ],
    [
      t,
      job,
      pods,
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
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Job}
      title={job?.name || name || ""}
      namespace={job?.namespace || namespace}
      createdAt={job?.createdAt}
      statusBadge={job && <StatusBadge status={job.status} />}
      badges={
        failed > 0 && (
          <span className="text-[11px] text-err">
            {t("count", "failedPods", { n: failed })}
          </span>
        )
      }
      onBack={goBack}
      actions={
        <InterceptedAction
          intercept={intercept("Delete")}
          label={t("action", "delete")}
          icon={Trash2}
          onClick={() => deleteMutation?.mutate()}
          busy={deleteMutation?.isPending}
          danger
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
  const ran = duration(job?.startTime ?? null, job?.completionTime ?? null);

  return [
    {
      label: "Started",
      value: job?.startTime ? formatDate(job.startTime) : "not started",
      tone: job?.startTime ? undefined : "warn",
    },
    {
      label: t("action", "finished"),
      value: job?.completionTime
        ? formatDate(job.completionTime)
        : t("action", "stillRunning"),
    },
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
    serviceAccountRow(job?.serviceAccountName, job?.namespace),
  ];
}
