import { useMemo } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
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
import { deliveryOfKind } from "@/lib/delivery";
import {
  CountBlock,
  FactBlock,
  WorkloadOverview,
} from "@/components/resources/workload-overview";
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
import { useConnections } from "@/hooks/useConnections";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { DaemonSetDetailInfo } from "@/generated/types";
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

  const connections = useConnections(ResourceType.DaemonSet, name, namespace);

  // The DaemonSet publishes its own selector, in the API's own text form —
  // so a set-based one reaches the API server as written, where rebuilding
  // it from match labels dropped it and listed nothing.
  const labelSelector = daemonSet?.selector || null;

  // The failure travels. It used to be caught and turned into an empty
  // array, which the card then reported as "no pods for this workload" — a
  // claim about the cluster made from a question nobody answered, and the
  // reading somebody takes to mean their DaemonSet is down.
  const { data: pods = [], error: podsError } = useLiveQuery({
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
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!namespace && !!labelSelector,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });

  const deliveryQuery = deliveryOfKind(ResourceType.DaemonSet, daemonSet);
  const intercept = useDeliveryIntercept(deliveryQuery);

  const desired = daemonSet?.desired ?? 0;
  const current = daemonSet?.current ?? 0;
  const ready = daemonSet?.ready ?? 0;
  const upToDate = daemonSet?.upToDate ?? 0;
  const available = daemonSet?.available ?? 0;
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
                          label: t("count", "readyWord"),
                          count: ready,
                          tone: "ok",
                        },
                        {
                          label: t("count", "notReadyWord"),
                          count: Math.max(0, current - ready),
                          tone: "warn",
                        },
                        {
                          label: t("count", "notScheduledSegment"),
                          count: Math.max(0, desired - current),
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
                          label: t("action", "barUpToDate"),
                          count: upToDate,
                          tone: "ok",
                        },
                        {
                          label: t("action", "barOutdated"),
                          count: Math.max(0, desired - upToDate),
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
                        label: "Pods",
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
      connectionsTab(connections, deliveryQuery),
      {
        id: "container-template",
        label: t("columns", "template"),
        glyph: viewGlyph(Layers2),
        content: <ContainerRows template={daemonSet} namespace={namespace} />,
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
        label: "Conditions",
        glyph: viewGlyph(BadgeCheck),
        mark: conditionsMark(daemonSet?.conditions),
        content: (
          <Section>
            <SectionHeader
              title="Conditions"
              count={daemonSet?.conditions.length}
            />
            <ConditionRows
              conditions={daemonSet?.conditions ?? []}
              subject={{ kind: ResourceType.DaemonSet, name, namespace }}
            />
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
    [
      daemonSet,
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
      upToDate,
      available,
      t,
    ]
  );

  if (!daemonSet && !isLoading && !error) {
    return null;
  }

  return (
    <ResourceDetailLayout
      freshness={freshness}
      resource={daemonSet}
      delivery={deliveryQuery}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.DaemonSet}
      title={daemonSet?.name || name || ""}
      namespace={daemonSet?.namespace || namespace}
      createdAt={daemonSet?.createdAt}
      statusBadge={
        daemonSet && (
          <StatusBadge status={short ? "Degraded" : "Ready"}>
            {t("count", "slashReady", { n: ready, total: desired })}
          </StatusBadge>
        )
      }
      badges={
        upToDate < desired && (
          <span className="text-[11px] text-info">
            {t("action", "rollingOut")}
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
