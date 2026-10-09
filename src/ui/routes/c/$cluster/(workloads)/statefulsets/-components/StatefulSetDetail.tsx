import { useMemo, useState } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import {
  AlignLeft,
  BadgeCheck,
  History,
  Info,
  Layers2,
  Scale,
} from "lucide-react";

import { LogViewer } from "../../../-logs/LogViewer";
import { useAsk } from "../../../-object/useAsk";
import { lanePodOf } from "../../../-logs/lanes";
import { Section, SectionHeader } from "@/components/ui/section";
import { RolloutBadge, RolloutSummary } from "../../../-object/RolloutSummary";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { RelatedResources } from "../../-components/RelatedResources";
import { TrafficChain } from "../../../-object/TrafficChain";
import { ChainWatches } from "../../../-object/ChainWatches";
import { connectionsTab } from "../../../-object/connections-tab";
import { PodListCard } from "../../../-object/PodListCard";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import {
  conditionsMark,
  kindGlyph,
  podsMark,
  viewGlyph,
} from "@/components/object/detail-tab";
import { ContainerRows } from "../../../-object/container-rows";
import { ChangesTab } from "../../-components/ChangesTab";
import { deliveryOfKind } from "@/lib/delivery";
import { RestartAction } from "../../../-object/RestartDialog";
import { readinessOf } from "@/lib/restart-plan";
import { guardedOf, useDenied } from "@/lib/access";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import {
  Composition,
  ConditionRows,
  ReasonedAction,
} from "@/components/object/detail-blocks";
import { ScaleDialog } from "../../../-object/ScaleDialog";
import { scaleWarnings } from "@/lib/governance";
import { serviceAccountRow } from "../../-components/identity-rows";
import { WorkloadUsage } from "../../-components/workload-usage";
import { ResourceRef } from "@/components/object/ResourceRef";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { useResourceDetail, useResourceMutation } from "@/hooks";
import { useStatefulSetShare } from "./useStatefulSetShare";
import { setReplicaSegments } from "./set-replicas";
import { useStartsClock } from "../../-components/replica-gap";
import { useWorkloadPods } from "../../-components/workload-pods";
import { useChainAnswer } from "@/hooks/useChainAnswer";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "../../-components/workload-overview";
import { AlertsAbout } from "../../../-object/AlertsAbout";
import { PinAction } from "../../-components/PinAction";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useOwnedPodsWatch } from "@/hooks/usePodWatch";
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
  const scaleDenied = useDenied(
    guardedOf(ResourceType.StatefulSet, namespace || null)
  ).patch;

  const chain = useChainAnswer(ResourceType.StatefulSet, name, namespace);
  const connections = chain.read;

  const podsKey = queryKeys.ownedPods(
    ResourceType.StatefulSet,
    namespace,
    name
  );
  // The failure travels rather than becoming an empty list; see the same
  // change on the DaemonSet page.
  const podsQuery = useLiveQuery({
    queryKey: podsKey,
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
  const {
    pods,
    error: podsError,
    isPending: podsPending,
    refetch: refetchPods,
    split: splitPods,
  } = useWorkloadPods(
    ResourceType.StatefulSet,
    namespace,
    name,
    podsQuery,
    podsKey,
    statefulSet?.replicas.ready
  );
  useOwnedPodsWatch(
    ResourceType.StatefulSet,
    namespace,
    name,
    [podsKey, chain.key],
    !!statefulSet
  );

  const deliveryQuery = deliveryOfKind(ResourceType.StatefulSet, statefulSet);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const [scaleOpen, setScaleOpen] = useState(false);
  const asking = useAsk();

  const restartMutation = useResourceMutation(
    async () => {
      if (!name) return;
      await commands.restartStatefulset(name, namespace || null);
    },
    {
      toast: {
        successTitle: t("action", "kindRestarted", {
          kind: ResourceType.StatefulSet,
        }),
        successDescription: t("action", "kindRestartingDetail", {
          kind: ResourceType.StatefulSet,
          name: name ?? "",
        }),
        errorPrefix: t("action", "restartKindFailed", {
          kind: ResourceType.StatefulSet,
        }),
      },
      invalidateQueryKeys:
        namespace && name
          ? [queryKeys.detail(ResourceType.StatefulSet, namespace, name)]
          : [],
      onSuccess: () => {
        if (!name) return;
        asking.ask(
          { kind: "StatefulSet", namespace: namespace || null, name },
          {
            action: "restart",
            replicas: null,
            generationBefore: statefulSet?.generation ?? null,
          }
        );
      },
    }
  );

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
        namespace && name
          ? [queryKeys.detail(ResourceType.StatefulSet, namespace, name)]
          : [],
      onSuccess: () => setScaleOpen(false),
    }
  );

  const replicas = statefulSet?.replicas;
  const desired = replicas?.desired ?? 0;
  const current = replicas?.current ?? 0;
  const ready = replicas?.ready ?? 0;

  const events = useObjectEvents(ResourceType.StatefulSet, name, namespace, {
    refresh: "slow",
  });

  const share = useStatefulSetShare(statefulSet, pods, podsError);
  const startsNow = useStartsClock(splitPods);

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
                  kind={ResourceType.StatefulSet}
                  name={name ?? ""}
                  namespace={namespace ?? null}
                />
              }
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
                    segments={setReplicaSegments(
                      { desired, current, ready },
                      splitPods,
                      startsNow,
                      statefulSet?.rollout,
                      t
                    )}
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
                  podsError={podsError}
                  podsPending={podsPending}
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
      connectionsTab(connections, t, deliveryQuery),
      {
        id: "container-template",
        label: t("columns", "template"),
        glyph: viewGlyph(Layers2),
        content: <ContainerRows template={statefulSet} namespace={namespace} />,
      },
      {
        id: "changes",
        label: t("changes", "title"),
        glyph: viewGlyph(History),
        content: statefulSet ? (
          <ChangesTab
            subject={{
              kind: "StatefulSet",
              name: statefulSet.name,
              namespace: statefulSet.namespace,
              labels: statefulSet.labels,
              annotations: statefulSet.annotations,
              createdAt: statefulSet.createdAt,
            }}
          />
        ) : null,
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
            onRetry={() => void refetchPods()}
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
                laneRule="ordinal"
                workload={
                  name ? { owner: name, ownerKind: "StatefulSet" } : null
                }
                idle={
                  statefulSet && desired === 0
                    ? t("empty", "kindScaledToZero", {
                        kind: ResourceType.StatefulSet,
                      })
                    : null
                }
              />
            </div>
          </div>
        ),
      },
      {
        id: "conditions",
        label: t("columns", "conditions"),
        glyph: viewGlyph(BadgeCheck),
        mark: conditionsMark(statefulSet?.conditions, t),
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
      eventsTab(events, t, {
        kind: ResourceType.StatefulSet,
        name: name ?? "",
      }),
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
      events,
      t,
      statefulSet,
      pods,
      splitPods,
      podsError,
      podsPending,
      refetchPods,
      yaml,
      copyYaml,
      namespace,
      name,
      connections,
      deliveryQuery,
      desired,
      current,
      ready,
      startsNow,
    ]
  );

  if (!statefulSet && !isLoading && !error) {
    return null;
  }

  return (
    <>
      <ChainWatches services={chain.services} reads={[chain.key]} />
      <ResourceDetailLayout
        freshness={freshness}
        resource={statefulSet}
        delivery={deliveryQuery}
        share={share}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.StatefulSet}
        title={statefulSet?.name || name || ""}
        namespace={statefulSet?.namespace || namespace}
        createdAt={statefulSet?.createdAt}
        statusBadge={
          statefulSet && <RolloutBadge rollout={statefulSet.rollout} />
        }
        badges={
          statefulSet && (
            <span className="text-[11px] text-fg-mut">
              {t("count", "slashReady", { n: ready, total: desired })}
            </span>
          )
        }
        summary={
          statefulSet && (
            <RolloutSummary
              rollout={statefulSet.rollout}
              subject={{ kind: ResourceType.StatefulSet, name, namespace }}
            />
          )
        }
        onBack={goBack}
        actions={
          <>
            <PinAction kind="StatefulSet" namespace={namespace} name={name} />
            {/* Plain, not intercepted: the Scale dialog carries the delivery
                warning itself, stacked with the autoscaler's. A second dialog
                in front of it would ask the same question twice. */}
            <ReasonedAction
              label={t("action", "scale")}
              reason={scaleDenied}
              icon={Scale}
              onClick={() => statefulSet && setScaleOpen(true)}
            />
            <RestartAction
              kind={ResourceType.StatefulSet}
              name={name ?? ""}
              namespace={namespace || null}
              plan={statefulSet?.rolloutPlan}
              readiness={readinessOf(statefulSet)}
              intercept={intercept("Restart")}
              mutation={restartMutation}
            />
            <DeleteAction
              kind={ResourceType.StatefulSet}
              name={statefulSet?.name || name || ""}
              namespace={statefulSet?.namespace || namespace}
              detail={statefulSet}
              intercept={intercept("Delete")}
              mutation={deleteMutation}
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
        name={name ?? ""}
        namespace={namespace || null}
        current={replicas?.desired}
        busy={scaleMutation.isPending}
        onSubmit={(replicas) => scaleMutation.mutate(replicas)}
      />
      {asking.dialog}
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
