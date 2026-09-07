import { useMemo, useState } from "react";
import { nodeReadyWord } from "@/lib/node-reporting";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  BadgeCheck,
  Bug,
  Info,
  Shield,
  ShieldOff,
  Tag,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { MetricsStatusBanner } from "@/components/metrics";
import { DebugNodeDialog } from "@/components/debug";
import { yamlTab } from "@/components/resources/yaml-tab";
import { connectionsTab } from "@/components/resources/connections-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { conditionsMark, viewGlyph } from "@/components/resources/detail-tab";
import {
  ConditionRows,
  DetailAction,
  UsageRow,
} from "@/components/resources/detail-blocks";
import { UsageBlock } from "@/components/resources/usage-block";
import { NodeResources } from "@/components/resources/NodeResources";
import { PodListCard } from "@/components/resources/PodListCard";
import { kindGlyph, podsMark } from "@/components/resources/detail-tab";
import { useLiveQuery } from "@/hooks/useLiveQuery";
import { useNodeActions } from "@/hooks/useNodeActions";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { SpotMark } from "@/components/resources/spot-mark";
import { nodePlacement, statesPlacement } from "@/lib/node-pool";
import { useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useMetrics } from "@/hooks/useMetrics";
import { commands } from "@/lib/commands";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { podsOnNode } from "@/lib/connections";
import { mergeNodesWithMetrics } from "@/lib/metrics";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { NodeInfo, DebugResult, TaintInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

/** A taint is the usual answer to "why is nothing scheduling here". */
function taintKeyValues(taints: TaintInfo[]): KeyValue[] {
  return taints.map((taint) => ({
    label: taint.key,
    value: `${taint.value ? `${taint.value} · ` : ""}${taint.effect}`,
    mono: true,
    tone: taint.effect === "PreferNoSchedule" ? undefined : ("warn" as const),
  }));
}

export function NodeDetail() {
  const t = useT();
  const navigate = useNavigate();
  const [debugDialogOpen, setDebugDialogOpen] = useState(false);

  const {
    name,
    resource: node,
    isLoading,
    error,
    yaml: nodeYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    freshness,
  } = useResourceDetail<NodeInfo>({
    resourceKind: ResourceType.Node,
    isClusterScoped: true,
    fetchResource: (name) => commands.getNode(name),
    defaultTab: "overview",
  });

  // A Node is cluster-scoped, so its neighbourhood is read with no namespace
  // at all — the same query the drain dialog opens, and the same answer.
  const connections = useConnections(ResourceType.Node, name, null);
  const podCount = podsOnNode(connections.data);

  const { nodeMetrics, nodeStatus, nodeSampledAt } = useMetrics({
    includePods: false,
    enabled: !!node,
  });
  const nodeWithMetrics = useMemo(() => {
    if (!node) return null;
    return mergeNodesWithMetrics([node], nodeMetrics)[0] ?? null;
  }, [node, nodeMetrics]);

  // The scheduler's promise on this machine, summed in Rust over the pods
  // here; unknown the moment one namespace refuses to list them.
  const budget = useLiveQuery({
    queryKey: ["node", "budget", name],
    queryFn: () => commands.nodeResourceBudget(name ?? ""),
    enabled: !!node && !!name,
    staleTime: STALE_TIMES.resourceDetail,
    refresh: "resourceDetail",
  });

  // The real pod rows, filtered by `spec.nodeName` on the server. Asked for
  // only while the tab is open: a node can carry a hundred of them.
  const podsOnThisNode = useLiveQuery({
    queryKey: ["node", "pods", name],
    queryFn: () =>
      commands.listPods({
        namespace: null,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
        statusFilter: null,
        selector: null,
        nodeName: name ?? null,
      }),
    enabled: !!node && !!name && activeTab === "pods",
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });

  const actions = useNodeActions();

  if (!node && !isLoading && !error) {
    return null;
  }

  const handleDebugStart = (result: DebugResult) => {
    navigate(
      `/${toPlural(ResourceType.Pod)}/${result.namespace}/${result.podName}`,
      { replace: false }
    );
  };

  const address = (type: string) =>
    node?.status.addresses.find((a) => a.type === type)?.address;

  const podCapacity = Number(node?.allocatable.pods ?? node?.capacity.pods);

  const facts: KeyValue[] = [
    {
      label: t("columns", "internalIp"),
      value: (
        <CopyableAddress
          value={address("InternalIP")}
          label={t("columns", "internalIp")}
          fallback="-"
        />
      ),
    },
    {
      label: t("columns", "externalIp"),
      value: (
        <CopyableAddress
          value={address("ExternalIP")}
          label={t("columns", "externalIp")}
          fallback="-"
        />
      ),
    },
    { label: "Hostname", value: address("Hostname") ?? "-", mono: true },
    { label: "Kubernetes", value: node?.version, mono: true },
    {
      label: t("columns", "containerRuntime"),
      value: node?.containerRuntime,
      mono: true,
    },
    { label: t("columns", "os"), value: node?.os },
    { label: t("columns", "architecture"), value: node?.arch },
    {
      label: t("columns", "created"),
      value: node?.createdAt ? new Date(node.createdAt).toLocaleString() : "-",
    },
  ];

  // What a managed cluster already states about the machine under this node.
  // Every row is dropped rather than stubbed when the cluster is silent, so a
  // k3d node keeps the page it had before any of this existed.
  const placement = node ? nodePlacement(node) : null;
  const machine: KeyValue[] = placement
    ? [
        ...(placement.pool
          ? [{ label: t("columns", "pool"), value: placement.pool, mono: true }]
          : []),
        ...(placement.machine
          ? [
              {
                label: t("columns", "instanceType"),
                value: placement.machine,
                mono: true,
              },
            ]
          : []),
        ...(placement.zone
          ? [{ label: t("columns", "zone"), value: placement.zone, mono: true }]
          : []),
        ...(placement.region
          ? [
              {
                label: t("settings", "region"),
                value: placement.region,
                mono: true,
              },
            ]
          : []),
        ...(placement.spot
          ? [
              {
                label: t("columns", "spotNode"),
                value: t("cluster", "spotNodeWarning"),
              },
            ]
          : []),
        // Named from the providerID's scheme and from nothing else. A pool
        // label can be typed by anyone; this is the cloud signing its work.
        ...(placement.cloud
          ? [{ label: t("columns", "cloud"), value: placement.cloud }]
          : []),
        ...(placement.providerId
          ? [
              {
                label: t("columns", "providerId"),
                value: placement.providerId,
                mono: true,
              },
            ]
          : []),
      ]
    : [];

  const tabs = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <>
          {nodeStatus?.status !== "available" && (
            <MetricsStatusBanner status={nodeStatus} />
          )}

          <UsageBlock
            title={t("columns", "headroom")}
            kind={ResourceType.Node}
            uid={node?.uid}
            cpu={nodeWithMetrics?.cpuMillicores}
            memory={nodeWithMetrics?.memoryBytes}
            cpuLimit={node?.capacity.cpu ? parseCPU(node.capacity.cpu) : null}
            memoryLimit={
              node?.capacity.memory ? parseMemory(node.capacity.memory) : null
            }
            limitNoun="capacityWord"
            sampledAt={nodeSampledAt}
            status={nodeStatus}
            history={node?.name ? { kind: "node", node: node.name } : undefined}
          >
            {/* A tally of scheduled pods, not a reading from metrics-server:
             *  it comes from the pod list, it moves in steps of one, and a line
             *  through it would imply a resolution it does not have. */}
            <UsageRow
              label="Pods"
              used={podCount}
              total={Number.isFinite(podCapacity) ? podCapacity : null}
              type="count"
            />
          </UsageBlock>

          <NodeResources
            budget={budget.data}
            error={budget.error ? normalizeTauriError(budget.error) : null}
            onRetry={() => void budget.refetch()}
            usage={
              nodeWithMetrics
                ? {
                    cpuMillicores: nodeWithMetrics.cpuMillicores ?? null,
                    memoryBytes: nodeWithMetrics.memoryBytes ?? null,
                  }
                : null
            }
            podsRunning={podCount ?? null}
          />

          <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
            <KeyValueSection title={t("columns", "host")} items={facts} />
            {placement && statesPlacement(placement) && (
              <KeyValueSection
                title={t("columns", "placement")}
                count={t("empty", "placementNote")}
                items={machine}
              />
            )}
          </div>
          {node && node.taints.length > 0 && (
            <KeyValueSection
              title="Taints"
              count={node.taints.length}
              items={taintKeyValues(node.taints)}
            />
          )}
        </>
      ),
    },
    {
      id: "pods",
      label: "Pods",
      glyph: kindGlyph(ResourceType.Pod),
      mark: podsMark(podsOnThisNode.data ?? []),
      content: (
        <PodListCard
          pods={podsOnThisNode.data ?? []}
          error={podsOnThisNode.error}
          emptyMessage={t("empty", "noPodsOnNode")}
        />
      ),
    },
    {
      id: "conditions",
      label: t("columns", "conditions"),
      glyph: viewGlyph(BadgeCheck),
      mark: conditionsMark(node?.status.conditions),
      content: (
        <Section>
          <SectionHeader
            title={t("columns", "conditions")}
            count={node?.status.conditions.length}
          />
          <ConditionRows
            conditions={node?.status.conditions ?? []}
            subject={{ kind: ResourceType.Node, name }}
          />
        </Section>
      ),
    },
    {
      id: "labels",
      label: t("columns", "labels"),
      glyph: viewGlyph(Tag),
      content: (
        <KeyValueSection
          title={t("columns", "labels")}
          count={Object.keys(node?.labels ?? {}).length}
          items={recordToKeyValues(node?.labels ?? {})}
          // A whole tab, not a row beside Annotations — and every node kubelet
          // registers carries `kubernetes.io/*`, so an empty one is the read
          // failing rather than a node with nothing to say about itself.
          emptyMessage={t("empty", "noLabelsOnNode")}
        />
      ),
    },
    connectionsTab(connections, t),
    yamlTab({
      title: t("action", "kindYaml", { kind: "Node" }),
      yaml: nodeYaml,
      resourceKind: ResourceType.Node,
      resourceName: name || "",
      namespace: undefined,
      onCopy: copyYaml,
    }),
  ];

  return (
    <>
      <ResourceDetailLayout
        freshness={freshness}
        resource={node}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.Node}
        title={node?.name || ""}
        createdAt={node?.createdAt}
        statusBadge={node && <StatusBadge status={nodeReadyWord(node)} />}
        badges={[
          ...(node?.roles.map((role) => (
            <span key={role} className="text-[11px] text-fg-fnt">
              {role}
            </span>
          )) ?? []),
          ...(placement?.spot ? [<SpotMark key="spot" says="spot" />] : []),
        ]}
        onBack={goBack}
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        actions={
          <>
            {node?.unschedulable ? (
              <DetailAction
                label={t("action", "uncordon")}
                icon={Shield}
                onClick={() => node && actions.uncordon(node.name)}
                disabled={!node}
              />
            ) : (
              <DetailAction
                label={t("action", "cordon")}
                icon={ShieldOff}
                onClick={() => node && actions.cordon(node.name)}
                disabled={!node}
              />
            )}
            <DetailAction
              label={t("action", "drain")}
              icon={AlertTriangle}
              onClick={() => node && actions.drain(node.name)}
              disabled={!node}
              danger
            />
            <DetailAction
              label={t("action", "debugNode")}
              icon={Bug}
              onClick={() => setDebugDialogOpen(true)}
              disabled={!node}
            />
          </>
        }
      />
      {actions.dialogs}

      {/* Outside the frame: Debug is on the strip's row and so on every tab,
          and a dialog inside the open tab's panel would go with the tab. */}
      {node && (
        <DebugNodeDialog
          open={debugDialogOpen}
          onOpenChange={setDebugDialogOpen}
          nodeName={node.name}
          onDebugStart={handleDebugStart}
        />
      )}
    </>
  );
}
