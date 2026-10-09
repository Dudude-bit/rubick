import { useCallback, useMemo } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { AlignLeft, BadgeCheck, History, Info, Layers2 } from "lucide-react";

import { LogViewer } from "../../../-logs/LogViewer";
import { lanePodOf } from "../../../-logs/lanes";
import { Section, SectionHeader } from "@/components/ui/section";
import { RolloutBadge, RolloutSummary } from "../../../-object/RolloutSummary";
import { yamlTab } from "../../../-object/yaml-tab";
import { eventsTab } from "../../../-object/events-tab";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { RelatedResources } from "../../-components/RelatedResources";
import { replicaSplit, useStartsClock } from "../../-components/replica-gap";
import { useWorkloadPods } from "../../-components/workload-pods";
import { workloadRole } from "@/lib/workload-status";
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
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "../../-components/workload-overview";
import { AlertsAbout } from "../../../-object/AlertsAbout";
import { RestartAction } from "../../../-object/RestartDialog";
import { readinessOf } from "@/lib/restart-plan";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { Composition, ConditionRows } from "@/components/object/detail-blocks";
import { serviceAccountRow } from "../../-components/identity-rows";
import { WorkloadUsage } from "../../-components/workload-usage";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { PinAction } from "../../-components/PinAction";
import { useAsk } from "../../../-object/useAsk";
import { useResourceDetail, useResourceMutation } from "@/hooks";
import { useDaemonSetShare } from "./useDaemonSetShare";
import { useChainAnswer } from "@/hooks/useChainAnswer";
import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import { useOwnedPodsWatch } from "@/hooks/usePodWatch";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { DaemonSetDetailInfo, PodInfo } from "@/generated/types";
import { controlledBy } from "@/lib/controlled-by";
import { useT } from "@/i18n/useT";

export function DaemonSetDetail() {
  const t = useT();
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
    freshness,
  } = useResourceDetail<DaemonSetDetailInfo>({
    resourceKind: ResourceType.DaemonSet,
    fetchResource: (name, ns) => commands.getDaemonset(name, ns),
    deleteResource: (name, ns) => commands.deleteDaemonset(name, ns),
    defaultTab: "overview",
  });

  const asking = useAsk();

  const restartMutation = useResourceMutation(
    async () => {
      if (!name) return;
      await commands.restartDaemonset(name, namespace || null);
    },
    {
      toast: {
        successTitle: t("action", "kindRestarted", {
          kind: ResourceType.DaemonSet,
        }),
        successDescription: t("action", "kindRestartingDetail", {
          kind: ResourceType.DaemonSet,
          name: name ?? "",
        }),
        errorPrefix: t("action", "restartKindFailed", {
          kind: ResourceType.DaemonSet,
        }),
      },
      invalidateQueryKeys:
        namespace && name
          ? [queryKeys.detail(ResourceType.DaemonSet, namespace, name)]
          : [],
      onSuccess: () => {
        if (!name) return;
        asking.ask(
          { kind: "DaemonSet", namespace: namespace || null, name },
          {
            action: "restart",
            replicas: null,
            generationBefore: daemonSet?.generation ?? null,
          }
        );
      },
    }
  );

  const chain = useChainAnswer(ResourceType.DaemonSet, name, namespace);
  const connections = chain.read;

  // The DaemonSet publishes its own selector, in the API's own text form —
  // so a set-based one reaches the API server as written, where rebuilding
  // it from match labels dropped it and listed nothing.
  const labelSelector = daemonSet?.selector || null;
  const podsKey = queryKeys.ownedPods(
    ResourceType.DaemonSet,
    namespace,
    name,
    labelSelector
  );

  // The failure travels. It used to be caught and turned into an empty
  // array, which the card then reported as "no pods for this workload" — a
  // claim about the cluster made from a question nobody answered, and the
  // reading somebody takes to mean their DaemonSet is down.
  const podsQuery = useLiveQuery({
    queryKey: podsKey,
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
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!namespace && !!labelSelector,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
    select: useCallback(
      (pods: PodInfo[]) => controlledBy(pods, daemonSet?.uid),
      [daemonSet?.uid]
    ),
  });
  const {
    pods,
    error: podsError,
    isPending: podsPending,
    refetch: refetchPods,
    split: splitPods,
  } = useWorkloadPods(
    ResourceType.DaemonSet,
    namespace,
    name,
    podsQuery,
    podsKey,
    daemonSet?.ready
  );
  useOwnedPodsWatch(
    ResourceType.DaemonSet,
    namespace,
    name,
    [podsKey, chain.key],
    !!labelSelector
  );

  const deliveryQuery = deliveryOfKind(ResourceType.DaemonSet, daemonSet);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const desired = daemonSet?.desired ?? 0;
  const current = daemonSet?.current ?? 0;
  const ready = daemonSet?.ready ?? 0;
  const startsNow = useStartsClock(splitPods);
  const waiting = !!daemonSet && workloadRole(daemonSet.rollout) === "pending";
  const split = useMemo(
    () =>
      replicaSplit(current, ready, splitPods, startsNow, t, waiting, "node"),
    [current, ready, splitPods, startsNow, t, waiting]
  );
  const upToDate = daemonSet?.upToDate ?? 0;
  const outdated = Math.max(0, desired - upToDate);
  const unscheduled = Math.max(0, desired - current);
  const available = daemonSet?.available ?? 0;

  const events = useObjectEvents(ResourceType.DaemonSet, name, namespace, {
    refresh: "slow",
  });

  const share = useDaemonSetShare(daemonSet, pods, podsError);

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
                  kind={ResourceType.DaemonSet}
                  name={name ?? ""}
                  namespace={namespace ?? null}
                />
              }
              count={
                <CountBlock
                  title={t("columns", "rollout")}
                  subject={t("action", "rolloutSubject")}
                  governance={connections}
                >
                  {/* One fact, not five: desired/current/ready/up-to-date/
                      available are the same rollout read five ways, and the
                      reader was left to subtract them to find the gap. Two bars
                      rather than one because a DaemonSet counts two things —
                      how many nodes have a pod, and how many of those pods are
                      the current spec. */}
                  <div className="grid grid-cols-2 gap-[22px]">
                    <Composition
                      total={desired}
                      label={t("count", "nodesWanted", { n: desired })}
                      segments={[
                        {
                          label: t("count", "nodesReadySegment", {
                            n: split.ready,
                          }),
                          count: split.ready,
                          tone: "ok",
                        },
                        ...split.gap,
                        {
                          label: t("count", "notScheduledSegment", {
                            n: unscheduled,
                          }),
                          count: unscheduled,
                          tone: "err",
                        },
                      ]}
                      note={t("action", "nAvailable", { n: available })}
                    />
                    <Composition
                      total={desired}
                      label={t("action", "onCurrentSpec")}
                      segments={[
                        {
                          label: t("action", "barUpToDate", { n: upToDate }),
                          count: upToDate,
                          tone: "ok",
                        },
                        {
                          label: t("action", "barOutdated", { n: outdated }),
                          count: outdated,
                          tone: "warn",
                        },
                      ]}
                    />
                  </div>
                </CountBlock>
              }
              usage={
                <WorkloadUsage
                  kind={ResourceType.DaemonSet}
                  uid={daemonSet?.uid}
                  name={daemonSet?.name || name}
                  namespace={daemonSet?.namespace || namespace}
                  template={daemonSet}
                  pods={pods}
                  podsError={podsError}
                  podsPending={podsPending}
                  idle={
                    desired === 0
                      ? t("empty", "daemonSetNoNodeMatches")
                      : t("empty", "kindNoPodsRunning", {
                          kind: ResourceType.DaemonSet,
                        })
                  }
                  connections={connections.data}
                />
              }
              traffic={<TrafficChain query={connections} />}
              declared={
                <FactBlock
                  title={t("action", "howDeclared")}
                  items={declaration(daemonSet, t)}
                />
              }
            >
              {daemonSet && (
                <RelatedResources
                  ownerReferences={daemonSet.ownerReferences}
                  namespace={daemonSet.namespace}
                />
              )}
            </WorkloadOverview>

            <KeyValueSection
              title={t("columns", "selector")}
              items={
                daemonSet?.selector
                  ? [
                      {
                        label: t("columns", "pods"),
                        value: daemonSet.selector,
                        mono: true,
                      },
                    ]
                  : []
              }
              emptyMessage={t("empty", "noSelectorDaemonSet")}
            />
            <KeyValueSection
              title={t("columns", "labels")}
              count={Object.keys(daemonSet?.labels ?? {}).length}
              items={recordToKeyValues(daemonSet?.labels ?? {})}
              emptyMessage={t("empty", "noLabels")}
            />
            <KeyValueSection
              title={t("columns", "annotations")}
              count={Object.keys(daemonSet?.annotations ?? {}).length}
              items={recordToKeyValues(daemonSet?.annotations ?? {})}
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
        content: <ContainerRows template={daemonSet} namespace={namespace} />,
      },
      {
        id: "changes",
        label: t("changes", "title"),
        glyph: viewGlyph(History),
        content: daemonSet ? (
          <ChangesTab
            subject={{
              kind: "DaemonSet",
              name: daemonSet.name,
              namespace: daemonSet.namespace,
              labels: daemonSet.labels,
              annotations: daemonSet.annotations,
              createdAt: daemonSet.createdAt,
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
                laneRule="node"
                workload={name ? { owner: name, ownerKind: "DaemonSet" } : null}
                idle={
                  daemonSet && desired === 0
                    ? t("empty", "daemonSetNoNodeMatches")
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
        mark: conditionsMark(daemonSet?.conditions, t),
        content: (
          <Section>
            <SectionHeader
              title={t("columns", "conditions")}
              count={daemonSet?.conditions.length}
            />
            <ConditionRows
              conditions={daemonSet?.conditions ?? []}
              subject={{ kind: ResourceType.DaemonSet, name, namespace }}
            />
          </Section>
        ),
      },
      eventsTab(events, t, { kind: ResourceType.DaemonSet, name: name ?? "" }),
      yamlTab({
        yaml,
        onCopy: copyYaml,
        title: t("action", "kindYaml", { kind: "DaemonSet" }),
        resourceKind: ResourceType.DaemonSet,
        resourceName: daemonSet?.name || name || "",
        namespace: daemonSet?.namespace || namespace,
      }),
    ],
    [
      events,
      daemonSet,
      pods,
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
      unscheduled,
      split,
      upToDate,
      outdated,
      available,
      t,
    ]
  );

  if (!daemonSet && !isLoading && !error) {
    return null;
  }

  return (
    <>
      <ChainWatches services={chain.services} reads={[chain.key]} />
      <ResourceDetailLayout
        freshness={freshness}
        resource={daemonSet}
        delivery={deliveryQuery}
        share={share}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.DaemonSet}
        title={daemonSet?.name || name || ""}
        namespace={daemonSet?.namespace || namespace}
        createdAt={daemonSet?.createdAt}
        statusBadge={daemonSet && <RolloutBadge rollout={daemonSet.rollout} />}
        badges={
          daemonSet && (
            <span className="text-[11px] text-fg-mut">
              {t("count", "slashReady", { n: ready, total: desired })}
            </span>
          )
        }
        summary={
          daemonSet && (
            <RolloutSummary
              rollout={daemonSet.rollout}
              subject={{ kind: ResourceType.DaemonSet, name, namespace }}
            />
          )
        }
        onBack={goBack}
        actions={
          <>
            <PinAction kind="DaemonSet" namespace={namespace} name={name} />
            <RestartAction
              kind={ResourceType.DaemonSet}
              name={name ?? ""}
              namespace={namespace || null}
              plan={daemonSet?.rolloutPlan}
              readiness={readinessOf(daemonSet)}
              intercept={intercept("Restart")}
              mutation={restartMutation}
            />
            <DeleteAction
              kind={ResourceType.DaemonSet}
              name={daemonSet?.name || name || ""}
              namespace={daemonSet?.namespace || namespace}
              detail={daemonSet}
              intercept={intercept("Delete")}
              mutation={deleteMutation}
            />
          </>
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />
      {/* Past the per-cluster cap this asks which watch to give up. Without
          it the restart's ask stores a pending replacement nobody is ever
          shown, and following the rollout simply does not happen. */}
      {asking.dialog}
    </>
  );
}

/** How it is declared: read once, and never while the rollout is fine. */
function declaration(
  daemonSet: DaemonSetDetailInfo | undefined,
  t: ReturnType<typeof useT>
): KeyValue[] {
  return [
    {
      label: t("action", "updateStrategy"),
      value: daemonSet?.updateStrategy || "RollingUpdate",
    },
    serviceAccountRow(daemonSet?.serviceAccountName, daemonSet?.namespace, t),
  ];
}
