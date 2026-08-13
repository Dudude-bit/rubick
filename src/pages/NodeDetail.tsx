import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BadgeCheck, Bug, Info, Tag } from "lucide-react";

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
import {
  formatKubernetesBytes,
  parseCPU,
  parseMemory,
} from "@/lib/k8s-quantity";
import { podsOnNode } from "@/lib/connections";
import { mergeNodesWithMetrics } from "@/lib/metrics";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { NodeInfo, DebugResult, TaintInfo } from "@/generated/types";

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
      label: "Internal IP",
      value: (
        <CopyableAddress
          value={address("InternalIP")}
          label="Internal IP"
          fallback="-"
        />
      ),
    },
    {
      label: "External IP",
      value: (
        <CopyableAddress
          value={address("ExternalIP")}
          label="External IP"
          fallback="-"
        />
      ),
    },
    { label: "Hostname", value: address("Hostname") ?? "-", mono: true },
    { label: "Kubernetes", value: node?.version, mono: true },
    { label: "Container runtime", value: node?.containerRuntime, mono: true },
    { label: "OS", value: node?.os },
    { label: "Architecture", value: node?.arch },
    {
      label: "Created",
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
          ? [{ label: "Pool", value: placement.pool, mono: true }]
          : []),
        ...(placement.machine
          ? [{ label: "Instance type", value: placement.machine, mono: true }]
          : []),
        ...(placement.zone
          ? [{ label: "Zone", value: placement.zone, mono: true }]
          : []),
        ...(placement.region
          ? [{ label: "Region", value: placement.region, mono: true }]
          : []),
        ...(placement.spot
          ? [
              {
                label: "Spot",
                value:
                  "The cloud can take this node back at any time. Pods leaving here are the arrangement, not a fault.",
              },
            ]
          : []),
        // Named from the providerID's scheme and from nothing else. A pool
        // label can be typed by anyone; this is the cloud signing its work.
        ...(placement.cloud
          ? [{ label: "Cloud", value: placement.cloud }]
          : []),
        ...(placement.providerId
          ? [
              {
                label: "Provider ID",
                value: placement.providerId,
                mono: true,
              },
            ]
          : []),
      ]
    : [];

  const allocatable: KeyValue[] = [
    { label: "CPU", value: node?.allocatable.cpu ?? "-", mono: true },
    {
      label: "Memory",
      value: formatKubernetesBytes(node?.allocatable.memory),
      mono: true,
    },
    { label: "Pods", value: node?.allocatable.pods ?? "-", mono: true },
    {
      label: "Ephemeral storage",
      value: formatKubernetesBytes(node?.allocatable.ephemeralStorage),
      mono: true,
    },
  ];

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          {nodeStatus?.status !== "available" && (
            <MetricsStatusBanner status={nodeStatus} />
          )}

          <UsageBlock
            title="Headroom"
            kind={ResourceType.Node}
            uid={node?.uid}
            cpu={nodeWithMetrics?.cpuMillicores}
            memory={nodeWithMetrics?.memoryBytes}
            cpuLimit={node?.capacity.cpu ? parseCPU(node.capacity.cpu) : null}
            memoryLimit={
              node?.capacity.memory ? parseMemory(node.capacity.memory) : null
            }
            limitNoun="capacity"
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

          <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
            <KeyValueSection title="Host" items={facts} />
            <KeyValueSection
              title="Allocatable"
              count="what the scheduler may hand out"
              items={allocatable}
            />
            {placement && statesPlacement(placement) && (
              <KeyValueSection
                title="Placement"
                count="what the cloud says this node is and where"
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
      id: "conditions",
      label: "Conditions",
      glyph: viewGlyph(BadgeCheck),
      mark: conditionsMark(node?.status.conditions),
      content: (
        <Section>
          <SectionHeader
            title="Conditions"
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
      label: "Labels",
      glyph: viewGlyph(Tag),
      content: (
        <KeyValueSection
          title="Labels"
          count={Object.keys(node?.labels ?? {}).length}
          items={recordToKeyValues(node?.labels ?? {})}
          // A whole tab, not a row beside Annotations — and every node kubelet
          // registers carries `kubernetes.io/*`, so an empty one is the read
          // failing rather than a node with nothing to say about itself.
          emptyMessage="No labels on this node — not even the kubernetes.io/* set kubelet registers, which usually means the object was not read."
        />
      ),
    },
    connectionsTab(connections),
    yamlTab({
      title: "Node YAML",
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
        statusBadge={
          node && (
            <StatusBadge status={node.status.ready ? "Ready" : "NotReady"} />
          )
        }
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
          <DetailAction
            label="Debug node"
            icon={Bug}
            onClick={() => setDebugDialogOpen(true)}
            disabled={!node}
          />
        }
      />

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
