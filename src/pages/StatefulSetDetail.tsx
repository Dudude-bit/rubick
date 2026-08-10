import { useMemo } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { BadgeCheck, Info, Layers2, Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { yamlTab } from "@/components/resources/yaml-tab";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { TrafficChain } from "@/components/resources/TrafficChain";
import { connectionsTab } from "@/components/resources/connections-tab";
import { PodListCard } from "@/components/resources/PodListCard";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  conditionsMark,
  kindGlyph,
  podsMark,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { ContainerRows } from "@/components/resources/container-rows";
import { declaredContainers } from "@/lib/container-sequence";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import {
  Composition,
  ConditionRows,
} from "@/components/resources/detail-blocks";
import { serviceAccountRow } from "@/components/resources/identity-rows";
import { WorkloadUsage } from "@/components/resources/workload-usage";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { Governance } from "@/components/resources/governance";
import { commands } from "@/lib/commands";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { StatefulSetDetailInfo } from "@/generated/types";

export function StatefulSetDetail() {
  const {
    name,
    namespace,
    resource: statefulSet,
    isLoading,
    error,
    yaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<StatefulSetDetailInfo>({
    resourceKind: ResourceType.StatefulSet,
    fetchResource: (name, ns) => commands.getStatefulset(name, ns),
    deleteResource: (name, ns) => commands.deleteStatefulset(name, ns),
    defaultTab: "overview",
  });

  const connections = useConnections(ResourceType.StatefulSet, name, namespace);

  const { data: pods = [] } = useQuery({
    queryKey: ["statefulset-pods", namespace, name],
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
        // The API does not expose a StatefulSet's match labels, but it does
        // guarantee the pod names: `<set>-0`, `<set>-1`, and so on. The old
        // `app=<name>` guess found nothing whenever the chart labelled
        // its pods differently.
        return all.filter(
          (pod) =>
            pod.name.startsWith(`${name}-`) &&
            /^\d+$/.test(pod.name.slice(name.length + 1))
        );
      } catch {
        return [];
      }
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  const deliveryQuery = deliveryOfKind(ResourceType.StatefulSet, statefulSet);
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
              count={Object.keys(statefulSet?.labels ?? {}).length}
              items={recordToKeyValues(statefulSet?.labels ?? {})}
              emptyMessage="No labels"
            />
            <KeyValueSection
              title="Annotations"
              count={Object.keys(statefulSet?.annotations ?? {}).length}
              items={recordToKeyValues(statefulSet?.annotations ?? {})}
              emptyMessage="No annotations"
            />
          </>
        ),
      },
      connectionsTab(connections, deliveryQuery),
      {
        id: "container-template",
        label: "Template",
        glyph: viewGlyph(Layers2),
        content: <ContainerRows template={statefulSet} namespace={namespace} />,
      },
      {
        id: toPlural(ResourceType.Pod),
        label: "Pods",
        glyph: kindGlyph(ResourceType.Pod),
        mark: podsMark(pods),
        content: <PodListCard pods={pods} />,
      },
      {
        id: "conditions",
        label: "Conditions",
        glyph: viewGlyph(BadgeCheck),
        mark: conditionsMark(statefulSet?.conditions),
        content: (
          <Section>
            <SectionHeader
              title="Conditions"
              count={statefulSet?.conditions.length}
            />
            <ConditionRows
              conditions={statefulSet?.conditions ?? []}
              subject={{ kind: ResourceType.StatefulSet, name, namespace }}
            />
          </Section>
        ),
      },
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: "StatefulSet YAML",
        resourceKind: ResourceType.StatefulSet,
        resourceName: statefulSet?.name || name || "",
        namespace: statefulSet?.namespace || namespace,
      }),
    ],
    [
      statefulSet,
      pods,
      yaml,
      copyYaml,
      namespace,
      name,
      connections,
      deliveryQuery,
    ]
  );

  if (!statefulSet && !isLoading && !error) {
    return null;
  }

  const replicas = statefulSet?.replicas;
  const desired = replicas?.desired ?? 0;
  const current = replicas?.current ?? 0;
  const ready = replicas?.ready ?? 0;
  const short = ready < desired;

  const facts: KeyValue[] = [
    {
      label: "Governing service",
      value: statefulSet?.serviceName ? (
        <ResourceRef
          kind={ResourceType.Service}
          name={statefulSet.serviceName}
          namespace={statefulSet.namespace}
          showKind={false}
        />
      ) : (
        // Without a headless service the stable network identity a
        // StatefulSet exists for does not resolve.
        "none — pods have no stable DNS"
      ),
      tone: statefulSet?.serviceName ? undefined : "warn",
    },
    {
      label: "Pod management",
      value: statefulSet?.podManagementPolicy || "OrderedReady",
    },
    {
      label: "Update strategy",
      value: statefulSet?.updateStrategy || "RollingUpdate",
    },
    {
      label: "Containers",
      value: statefulSet ? declaredContainers(statefulSet).length : 0,
      mono: true,
    },
    serviceAccountRow(statefulSet?.serviceAccountName, statefulSet?.namespace),
  ];

  return (
    <ResourceDetailLayout
      resource={statefulSet}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.StatefulSet}
      title={statefulSet?.name || name || ""}
      namespace={statefulSet?.namespace || namespace}
      createdAt={statefulSet?.createdAt}
      statusBadge={
        statefulSet && (
          <StatusBadge status={short ? "Degraded" : "Ready"}>
            {ready}/{desired} ready
          </StatusBadge>
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
      <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
        <Section>
          {/* Ordinals matter here: a StatefulSet brings replicas up one at a
              time, so the gap between desired and current is a queue, not a
              failure. The bar shows both without three separate rows. */}
          <SectionHeader
            title="Replicas"
            count={
              statefulSet?.podManagementPolicy === "Parallel"
                ? "started in parallel"
                : "started in order, one at a time"
            }
          />
          <Composition
            total={desired}
            label={desired === 1 ? "replica wanted" : "replicas wanted"}
            segments={[
              { label: "ready", count: ready, tone: "ok" },
              {
                label: "starting",
                count: Math.max(0, current - ready),
                tone: "warn",
              },
              {
                label: "not created",
                count: Math.max(0, desired - current),
                tone: "err",
              },
            ]}
          />
        </Section>
        <KeyValueSection title="StatefulSet" items={facts} />
        <WorkloadUsage
          kind={ResourceType.StatefulSet}
          uid={statefulSet?.uid}
          namespace={statefulSet?.namespace || namespace}
          template={statefulSet}
          pods={pods}
          idle={
            desired === 0
              ? "This StatefulSet is scaled to zero."
              : "None of this StatefulSet's pods is running."
          }
          connections={connections.data}
        />
        <Governance query={connections} />
      </div>

      <TrafficChain query={connections} />

      {statefulSet && (
        <RelatedResources
          ownerReferences={statefulSet.ownerReferences}
          namespace={statefulSet.namespace}
        />
      )}
    </ResourceDetailLayout>
  );
}
