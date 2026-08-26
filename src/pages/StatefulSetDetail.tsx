import { useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
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
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { StatefulSetDetailInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

export function StatefulSetDetail() {
  const t = useT();
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
    freshness,
  } = useResourceDetail<StatefulSetDetailInfo>({
    resourceKind: ResourceType.StatefulSet,
    fetchResource: (name, ns) => commands.getStatefulset(name, ns),
    deleteResource: (name, ns) => commands.deleteStatefulset(name, ns),
    defaultTab: "overview",
  });

  const connections = useConnections(ResourceType.StatefulSet, name, namespace);

  // The failure travels rather than becoming an empty list; see the same
  // change on the DaemonSet page.
  const { data: pods = [], error: podsError } = useLiveQuery({
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
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
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
        successTitle: t("action", "kindScaled", {
          kind: ResourceType.StatefulSet,
        }),
        successDescription: (_data, replicas) =>
          t("action", "kindScaledTo", {
            kind: ResourceType.StatefulSet,
            name: name ?? "",
            n: replicas,
          }),
        errorPrefix: t("action", "failedToScaleKind", {
          kind: ResourceType.StatefulSet,
        }),
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
        label: t("nav", "overview"),
        glyph: viewGlyph(Info),
        content: (
          <>
            <WorkloadOverview
              count={
                <CountBlock
                  title={t("columns", "replicas")}
                  governance={connections}
                >
                  {/* Ordinals matter here: a StatefulSet brings replicas up one
                      at a time, so the gap between desired and current is a
                      queue, not a failure. The bar shows both without three
                      separate rows, and the note under it is what explains the
                      gap — which is why the pod management policy is said there
                      rather than as a row in a fact table three blocks away. */}
                  <Composition
                    total={desired}
                    label={t("count", "replicasWanted", { n: desired })}
                    segments={[
                      {
                        label: t("count", "readySegment", { n: ready }),
                        count: ready,
                        tone: "ok",
                      },
                      {
                        label: t("count", "startingSegment", {
                          n: Math.max(0, current - ready),
                        }),
                        count: Math.max(0, current - ready),
                        tone: "warn",
                      },
                      {
                        label: t("count", "notCreatedSegment", {
                          n: Math.max(0, desired - current),
                        }),
                        count: Math.max(0, desired - current),
                        tone: "err",
                      },
                    ]}
                    note={
                      statefulSet?.podManagementPolicy === "Parallel"
                        ? t("empty", "startedInParallel")
                        : t("empty", "startedInOrder")
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
                      ? t("empty", "kindScaledToZero", {
                          kind: ResourceType.StatefulSet,
                        })
                      : t("empty", "kindNoPodsRunning", {
                          kind: ResourceType.StatefulSet,
                        })
                  }
                  connections={connections.data}
                />
              }
              traffic={<TrafficChain query={connections} />}
              declared={
                <FactBlock
                  title={t("columns", "howDeclared")}
                  items={declaration(statefulSet, t)}
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
              title={t("columns", "labels")}
              count={Object.keys(statefulSet?.labels ?? {}).length}
              items={recordToKeyValues(statefulSet?.labels ?? {})}
              emptyMessage={t("empty", "noLabels")}
            />
            <KeyValueSection
              title={t("columns", "annotations")}
              count={Object.keys(statefulSet?.annotations ?? {}).length}
              items={recordToKeyValues(statefulSet?.annotations ?? {})}
              emptyMessage={t("empty", "noAnnotations")}
            />
          </>
        ),
      },
      connectionsTab(connections, deliveryQuery),
      {
        id: "container-template",
        label: t("columns", "template"),
        glyph: viewGlyph(Layers2),
        content: <ContainerRows template={statefulSet} namespace={namespace} />,
      },
      {
        id: toPlural(ResourceType.Pod),
        label: "Pods",
        glyph: kindGlyph(ResourceType.Pod),
        mark: podsMark(pods),
        content: <PodListCard pods={pods} error={podsError} />,
      },
      {
        id: "conditions",
        label: t("columns", "conditions"),
        glyph: viewGlyph(BadgeCheck),
        mark: conditionsMark(statefulSet?.conditions),
        content: (
          <Section>
            <SectionHeader
              title={t("columns", "conditions")}
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
        title: t("action", "kindYaml", { kind: "StatefulSet" }),
        resourceKind: ResourceType.StatefulSet,
        resourceName: statefulSet?.name || name || "",
        namespace: statefulSet?.namespace || namespace,
      }),
    ],
    [
      t,
      statefulSet,
      pods,
      podsError,
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
        freshness={freshness}
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
              {t("count", "slashReady", { n: ready, total: desired })}
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
              label={t("action", "scale")}
              icon={Scale}
              onClick={() => statefulSet && setScaleOpen(true)}
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

      {/* Outside the frame, because it is opened from the strip's row and so
          from any tab — inside the Overview's panel it would be unmounted the
          moment the reader was on Logs, which is when Scale still has to
          work. It draws nothing until it is open, and portals when it is. */}
      <ScaleDialog
        warnings={scaleWarnings(connections.data, intercept("Scale"), t)}
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
  statefulSet: StatefulSetDetailInfo | undefined,
  t: ReturnType<typeof useT>
): KeyValue[] {
  return [
    {
      label: t("columns", "governingService"),
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
        t("empty", "noGoverningService")
      ),
      tone: statefulSet?.serviceName ? undefined : "warn",
    },
    {
      label: t("columns", "updateStrategy"),
      value: statefulSet?.updateStrategy || "RollingUpdate",
    },
    serviceAccountRow(
      statefulSet?.serviceAccountName,
      statefulSet?.namespace,
      t
    ),
  ];
}
