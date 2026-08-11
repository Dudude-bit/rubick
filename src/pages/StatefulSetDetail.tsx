import { useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { BadgeCheck, Info, Layers2, Scale, Trash2 } from "lucide-react";

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
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import {
  Composition,
  ConditionRows,
  DetailAction,
} from "@/components/resources/detail-blocks";
import { ScaleDialog } from "@/components/resources/ScaleDialog";
import { scaleWarnings } from "@/lib/governance";
import { serviceAccountRow } from "@/components/resources/identity-rows";
import { WorkloadUsage } from "@/components/resources/workload-usage";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail, useResourceMutation } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "@/components/resources/workload-overview";
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

  const [scaleOpen, setScaleOpen] = useState(false);

  const scaleMutation = useResourceMutation(
    async (replicas: number) => {
      if (!name) return;
      await commands.scaleStatefulset(name, replicas, namespace || null);
    },
    {
      toast: {
        successTitle: "StatefulSet scaled",
        successDescription: (_data, replicas) =>
          `StatefulSet ${name} scaled to ${replicas} replicas.`,
        errorPrefix: "Failed to scale StatefulSet",
      },
      invalidateQueryKeys:
        namespace && name ? [["statefulset", namespace, name]] : [],
      onSuccess: () => setScaleOpen(false),
    }
  );

  const replicas = statefulSet?.replicas;
  const desired = replicas?.desired ?? 0;
  const current = replicas?.current ?? 0;
  const ready = replicas?.ready ?? 0;
  const short = ready < desired;

  const tabs = useMemo(
    () => [
      {
        id: "overview",
        label: "Overview",
        glyph: viewGlyph(Info),
        content: (
          <>
            <WorkloadOverview
              count={
                <CountBlock title="Replicas" governance={connections}>
                  {/* Ordinals matter here: a StatefulSet brings replicas up one
                      at a time, so the gap between desired and current is a
                      queue, not a failure. The bar shows both without three
                      separate rows, and the note under it is what explains the
                      gap — which is why the pod management policy is said there
                      rather than as a row in a fact table three blocks away. */}
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
                    note={
                      statefulSet?.podManagementPolicy === "Parallel"
                        ? "Started in parallel"
                        : "Started in order, one at a time"
                    }
                  />
                </CountBlock>
              }
              usage={
                <WorkloadUsage
                  kind={ResourceType.StatefulSet}
                  uid={statefulSet?.uid}
                  name={statefulSet?.name || name}
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
              }
              traffic={<TrafficChain query={connections} />}
              declared={
                <FactBlock
                  title="How it is declared"
                  items={declaration(statefulSet)}
                />
              }
            >
              {statefulSet && (
                <RelatedResources
                  ownerReferences={statefulSet.ownerReferences}
                  namespace={statefulSet.namespace}
                />
              )}
            </WorkloadOverview>

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
      desired,
      current,
      ready,
    ]
  );

  if (!statefulSet && !isLoading && !error) {
    return null;
  }

  return (
    <>
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
          <>
            {/* Plain, not intercepted: the Scale dialog carries the delivery
                warning itself, stacked with the autoscaler's. A second dialog
                in front of it would ask the same question twice. */}
            <DetailAction
              label="Scale"
              icon={Scale}
              onClick={() => statefulSet && setScaleOpen(true)}
            />
            <InterceptedAction
              intercept={intercept("Delete")}
              label="Delete"
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

      {/* Outside the frame, because it is opened from the strip's row and so
          from any tab — inside the Overview's panel it would be unmounted the
          moment the reader was on Logs, which is when Scale still has to
          work. It draws nothing until it is open, and portals when it is. */}
      <ScaleDialog
        warnings={scaleWarnings(connections.data, intercept("Scale"))}
        open={scaleOpen}
        onOpenChange={setScaleOpen}
        kind={ResourceType.StatefulSet}
        current={desired}
        busy={scaleMutation.isPending}
        onSubmit={(replicas) => scaleMutation.mutate(replicas)}
      />
    </>
  );
}

/**
 * How it is declared: the facts a reader needs once, and never while the
 * object is fine.
 */
function declaration(
  statefulSet: StatefulSetDetailInfo | undefined
): KeyValue[] {
  return [
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
      label: "Update strategy",
      value: statefulSet?.updateStrategy || "RollingUpdate",
    },
    serviceAccountRow(statefulSet?.serviceAccountName, statefulSet?.namespace),
  ];
}
