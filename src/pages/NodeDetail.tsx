import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { BadgeCheck, Bug, Info, Tag } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { MetricsStatusBanner } from "@/components/metrics";
import { DebugNodeDialog } from "@/components/debug";
import { yamlTab } from "@/components/resources/yaml-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { conditionsMark, viewGlyph } from "@/components/resources/detail-tab";
import {
  ConditionRows,
  DetailAction,
  UsageRow,
} from "@/components/resources/detail-blocks";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceDetail } from "@/hooks";
import { useMetrics } from "@/hooks/useMetrics";
import { commands } from "@/lib/commands";
import {
  formatKubernetesBytes,
  parseCPU,
  parseMemory,
} from "@/lib/k8s-quantity";
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
  } = useResourceDetail<NodeInfo>({
    resourceKind: ResourceType.Node,
    isClusterScoped: true,
    fetchResource: (name) => commands.getNode(name),
    defaultTab: "info",
  });

  const { data: podCount } = useQuery({
    queryKey: ["node-pods", name],
    queryFn: async () => {
      if (!name) return 0;
      const pods = await commands.listPods({
        nodeName: name,
        namespace: null,
        selector: null,
        statusFilter: null,
        labelSelector: null,
        fieldSelector: null,
        limit: null,
      });
      return pods.length;
    },
    enabled: !!name,
    placeholderData: keepPreviousData,
  });

  const { nodeMetrics, nodeStatus } = useMetrics({
    includePods: false,
    includeCluster: false,
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
      id: "info",
      label: "Info",
      glyph: viewGlyph(Info),
      content: (
        <>
          <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
            <KeyValueSection title="Host" items={facts} />
            <KeyValueSection
              title="Allocatable"
              count="what the scheduler may hand out"
              items={allocatable}
            />
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
          <ConditionRows conditions={node?.status.conditions ?? []} />
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
          emptyMessage="No labels"
        />
      ),
    },
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
    <ResourceDetailLayout
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
      badges={node?.roles.map((role) => (
        <span key={role} className="text-[11px] text-fg-fnt">
          {role}
        </span>
      ))}
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
    >
      {nodeStatus?.status !== "available" && (
        <MetricsStatusBanner status={nodeStatus} />
      )}

      <Section>
        <SectionHeader
          title="Headroom"
          count="live usage against capacity · pods against allocatable"
        />
        <div>
          <UsageRow
            label="CPU"
            used={nodeWithMetrics?.cpuMillicores}
            total={node?.capacity.cpu ? parseCPU(node.capacity.cpu) : null}
            type="cpu"
          />
          <UsageRow
            label="Memory"
            used={nodeWithMetrics?.memoryBytes}
            total={
              node?.capacity.memory ? parseMemory(node.capacity.memory) : null
            }
            type="memory"
          />
          <UsageRow
            label="Pods"
            used={podCount}
            total={Number.isFinite(podCapacity) ? podCapacity : null}
            type="count"
          />
        </div>
      </Section>

      {node && (
        <DebugNodeDialog
          open={debugDialogOpen}
          onOpenChange={setDebugDialogOpen}
          nodeName={node.name}
          onDebugStart={handleDebugStart}
        />
      )}
    </ResourceDetailLayout>
  );
}
