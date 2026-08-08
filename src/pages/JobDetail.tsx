import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
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
  Composition,
  ConditionRows,
  DetailAction,
} from "@/components/resources/detail-blocks";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { commands } from "@/lib/commands";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { formatDate } from "@/lib/utils";
import type { JobDetailInfo } from "@/generated/types";

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
  } = useResourceDetail<JobDetailInfo>({
    resourceKind: ResourceType.Job,
    fetchResource: (name, ns) => commands.getJob(name, ns),
    deleteResource: (name, ns) => commands.deleteJob(name, ns),
    defaultTab: "overview",
  });

  const { data: pods = [] } = useQuery({
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
              count={Object.keys(job?.labels ?? {}).length}
              items={recordToKeyValues(job?.labels ?? {})}
              emptyMessage="No labels"
            />
            <KeyValueSection
              title="Annotations"
              count={Object.keys(job?.annotations ?? {}).length}
              items={recordToKeyValues(job?.annotations ?? {})}
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
            containers={job?.containers ?? []}
            namespace={namespace}
          />
        ),
      },
      {
        id: toPlural(ResourceType.Pod),
        label: "Pods",
        glyph: kindGlyph(ResourceType.Pod),
        mark: podsMark(pods),
        content: (
          <PodListCard pods={pods} emptyMessage="No pods for this job" />
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
            <ConditionRows conditions={job?.conditions ?? []} />
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
    [job, pods, yaml, copyYaml, namespace, name]
  );

  if (!job && !isLoading && !error) {
    return null;
  }

  // An unset `completions` means the job is done after one successful pod.
  const completions = job?.completions ?? 1;
  const parallelism = job?.parallelism ?? 1;
  const backoffLimit = job?.backoffLimit ?? 6;
  const succeeded = job?.succeeded ?? 0;
  const failed = job?.failed ?? 0;
  const active = job?.active ?? 0;
  const ran = duration(job?.startTime ?? null, job?.completionTime ?? null);

  const timing: KeyValue[] = [
    {
      label: "Started",
      value: job?.startTime ? formatDate(job.startTime) : "not started",
      tone: job?.startTime ? undefined : "warn",
    },
    {
      label: "Finished",
      value: job?.completionTime
        ? formatDate(job.completionTime)
        : "still running",
    },
    ...(ran ? [{ label: "Ran for", value: ran, mono: true }] : []),
    ...(job?.activeDeadlineSeconds
      ? [
          {
            label: "Deadline",
            value: `${job.activeDeadlineSeconds}s after start`,
            mono: true,
          },
        ]
      : []),
    {
      label: "Containers",
      value: job?.containers.length ?? 0,
      mono: true,
    },
  ];

  return (
    <ResourceDetailLayout
      resource={job}
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
            {failed} failed {failed === 1 ? "pod" : "pods"}
          </span>
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
      <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
        <Section>
          {/* Completions, parallelism and the backoff limit are one setting
              read three ways — how many runs, how fast, how many retries —
              so the two that qualify the count sit under it rather than
              beside it as equal rows. */}
          <SectionHeader
            title="Run"
            count={`${parallelism} at a time · up to ${backoffLimit} ${
              backoffLimit === 1 ? "retry" : "retries"
            }`}
          />
          <Composition
            total={completions}
            label={
              job?.completions == null
                ? "successful pod needed"
                : completions === 1
                  ? "completion wanted"
                  : "completions wanted"
            }
            segments={[
              { label: "succeeded", count: succeeded, tone: "neutral" },
              { label: "running", count: active, tone: "ok" },
              { label: "failed", count: failed, tone: "err" },
            ]}
            note={
              succeeded < completions && active === 0 && failed > 0
                ? "no pod is running and the last one failed"
                : undefined
            }
          />
        </Section>
        <KeyValueSection title="Timing" items={timing} />
      </div>

      {job && (
        <RelatedResources
          ownerReferences={job.ownerReferences}
          namespace={job.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
