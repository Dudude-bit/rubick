import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { PodListCard } from "@/components/resources/PodListCard";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
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
import type { DaemonSetDetailInfo } from "@/generated/types";

export function DaemonSetDetail() {
  const {
    name,
    namespace,
    resource: daemonSet,
    isLoading,
    error,
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

  // The DaemonSet publishes its own selector; the previous `app=<name>` guess
  // returned nothing for every chart that labels its pods any other way.
  const selector = daemonSet?.selector ?? {};
  const labelSelector =
    Object.entries(selector)
      .map(([key, value]) => `${key}=${value}`)
      .join(",") || null;

  const { data: pods = [] } = useQuery({
    queryKey: ["daemonset-pods", namespace, name, labelSelector],
    queryFn: async () => {
      if (!namespace) return [];
      try {
        return await commands.listPods({
          namespace,
          labelSelector,
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
    enabled: !!namespace && !!labelSelector,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: "Overview",
        content: (
          <>
            <KeyValueSection
              title="Selector"
              count={Object.keys(daemonSet?.selector ?? {}).length}
              items={recordToKeyValues(daemonSet?.selector ?? {})}
              emptyMessage="No selector — this DaemonSet matches nothing"
            />
            <KeyValueSection
              title="Labels"
              count={Object.keys(daemonSet?.labels ?? {}).length}
              items={recordToKeyValues(daemonSet?.labels ?? {})}
              emptyMessage="No labels"
            />
            <KeyValueSection
              title="Annotations"
              count={Object.keys(daemonSet?.annotations ?? {}).length}
              items={recordToKeyValues(daemonSet?.annotations ?? {})}
              emptyMessage="No annotations"
            />
          </>
        ),
      },
      {
        id: "container-template",
        label: "Template",
        content: (
          <ContainerRows
            containers={daemonSet?.containers ?? []}
            namespace={namespace}
          />
        ),
      },
      {
        id: toPlural(ResourceType.Pod),
        label: "Pods",
        content: <PodListCard pods={pods} />,
      },
      {
        id: "conditions",
        label: "Conditions",
        content: (
          <Section>
            <SectionHeader
              title="Conditions"
              count={daemonSet?.conditions.length}
            />
            <ConditionRows conditions={daemonSet?.conditions ?? []} />
          </Section>
        ),
      },
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: "DaemonSet YAML",
        resourceKind: ResourceType.DaemonSet,
        resourceName: daemonSet?.name || name || "",
        namespace: daemonSet?.namespace || namespace,
      }),
    ],
    [daemonSet, pods, yaml, copyYaml, namespace, name]
  );

  if (!daemonSet && !isLoading && !error) {
    return null;
  }

  const desired = daemonSet?.desired ?? 0;
  const current = daemonSet?.current ?? 0;
  const ready = daemonSet?.ready ?? 0;
  const upToDate = daemonSet?.upToDate ?? 0;
  const available = daemonSet?.available ?? 0;
  const short = ready < desired;

  const facts: KeyValue[] = [
    {
      label: "Update strategy",
      value: daemonSet?.updateStrategy || "RollingUpdate",
    },
    { label: "Available", value: available, mono: true },
    {
      label: "Containers",
      value: daemonSet?.containers.length ?? 0,
      mono: true,
    },
  ];

  return (
    <ResourceDetailLayout
      resource={daemonSet}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.DaemonSet}
      title={daemonSet?.name || name || ""}
      namespace={daemonSet?.namespace || namespace}
      createdAt={daemonSet?.createdAt}
      statusBadge={
        daemonSet && (
          <StatusBadge status={short ? "Degraded" : "Ready"}>
            {ready}/{desired} ready
          </StatusBadge>
        )
      }
      badges={
        upToDate < desired && (
          <span className="text-[11px] text-info">rolling out</span>
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
          {/* One fact, not five: desired/current/ready/up-to-date/available
              are the same rollout read five ways, and the reader was left to
              subtract them to find the gap. */}
          <SectionHeader title="Rollout" count="one pod per eligible node" />
          <div className="grid grid-cols-2 gap-[22px]">
            <Composition
              total={desired}
              label={desired === 1 ? "node wanted" : "nodes wanted"}
              segments={[
                { label: "ready", count: ready, tone: "ok" },
                {
                  label: "not ready",
                  count: Math.max(0, current - ready),
                  tone: "warn",
                },
                {
                  label: "not scheduled",
                  count: Math.max(0, desired - current),
                  tone: "err",
                },
              ]}
            />
            <Composition
              total={desired}
              label="on the current spec"
              segments={[
                { label: "up to date", count: upToDate, tone: "ok" },
                {
                  label: "outdated",
                  count: Math.max(0, desired - upToDate),
                  tone: "warn",
                },
              ]}
            />
          </div>
        </Section>
        <KeyValueSection title="DaemonSet" items={facts} />
      </div>

      {daemonSet && (
        <RelatedResources
          ownerReferences={daemonSet.ownerReferences}
          namespace={daemonSet.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
