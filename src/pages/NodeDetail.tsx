import { Badge } from "@/components/ui/badge";
import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { Bug } from "lucide-react";
import {
  formatKubernetesBytes,
  parseCPU,
  parseMemory,
} from "@/lib/k8s-quantity";
import { MetricCard } from "@/components/ui/metric-card";
import { ConditionsDisplay } from "@/components/resources/ConditionsDisplay";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { useMemo, useState } from "react";
import { commands } from "@/lib/commands";
import { useResourceDetail } from "@/hooks";
import {
  ResourceType,
  getResourceIcon,
  toPlural,
} from "@/lib/resource-registry";
import {
  InfoRow,
  ResourceDetailLayout,
} from "@/components/resources/ResourceDetailLayout";
import type { NodeInfo, DebugResult } from "@/generated/types";
import { DebugNodeDialog } from "@/components/debug";
import { Button } from "@/components/ui/button";
import { useNavigate } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useMetrics } from "@/hooks/useMetrics";
import { MetricsStatusBanner } from "@/components/metrics";
import { mergeNodesWithMetrics } from "@/lib/metrics";

const NodeIcon = getResourceIcon(ResourceType.Node);

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

  const openDebugDialog = async () => {
    if (!node) return;
    setDebugDialogOpen(true);
  };

  const handleDebugStart = (result: DebugResult) => {
    // Navigate to the debug pod
    navigate(
      `/${toPlural(ResourceType.Pod)}/${result.namespace}/${result.podName}`,
      { replace: false }
    );
  };

  const getInternalIP = () => {
    const internal = node?.status.addresses.find(
      (a) => a.type === "InternalIP"
    );
    return internal?.address || "-";
  };

  const getExternalIP = () => {
    const external = node?.status.addresses.find(
      (a) => a.type === "ExternalIP"
    );
    return external?.address || "-";
  };

  const tabs = [
    {
      id: "info",
      label: "Info",
      content: (
        <Section>
          <SectionHeader title="Node Information" />
          <div className="grid gap-4 md:grid-cols-2">
            <InfoRow
              label="Internal IP"
              value={<span className="font-mono">{getInternalIP()}</span>}
            />
            <InfoRow
              label="External IP"
              value={<span className="font-mono">{getExternalIP()}</span>}
            />
            <InfoRow label="Kubernetes Version" value={node?.version} />
            <InfoRow label="Container Runtime" value={node?.containerRuntime} />
            <InfoRow label="OS" value={node?.os} />
            <InfoRow label="Architecture" value={node?.arch} />
            <InfoRow
              label="Created"
              value={
                node?.createdAt
                  ? new Date(node.createdAt).toLocaleString()
                  : "-"
              }
            />
          </div>
        </Section>
      ),
    },
    {
      id: "conditions",
      label: "Conditions",
      content: (
        <ConditionsDisplay
          conditions={node?.status.conditions || []}
          title="Conditions"
        />
      ),
    },
    {
      id: "labels",
      label: "Labels",
      content: <LabelsDisplay labels={node?.labels || {}} title="Labels" />,
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="Node YAML"
          yaml={nodeYaml}
          resourceKind={ResourceType.Node}
          resourceName={name || ""}
          namespace={undefined}
          onCopy={copyYaml}
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={node}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Node}
      title={node?.name || ""}
      badges={
        node && (
          <>
            {node.roles.map((role) => (
              <Badge key={role} variant="outline">
                {role}
              </Badge>
            ))}
            <StatusBadge status={node.status.ready ? "Ready" : "NotReady"} />
          </>
        )
      }
      icon={<NodeIcon className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={openDebugDialog}
          disabled={!node}
        >
          <Bug className="mr-2 h-4 w-4" />
          Debug Node
        </Button>
      }
    >
      {nodeStatus?.status !== "available" && (
        <MetricsStatusBanner status={nodeStatus} />
      )}
      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard
          title="CPU Usage"
          used={nodeWithMetrics?.cpuMillicores ?? null}
          limit={node?.capacity.cpu ? parseCPU(node.capacity.cpu) : null}
          type="cpu"
          showProgressBar={true}
          description={
            node?.allocatable.cpu
              ? `Allocatable: ${node.allocatable.cpu}`
              : undefined
          }
        />

        <MetricCard
          title="Memory Usage"
          used={nodeWithMetrics?.memoryBytes ?? null}
          limit={
            node?.capacity.memory ? parseMemory(node.capacity.memory) : null
          }
          type="memory"
          showProgressBar={true}
          description={
            node?.allocatable.memory
              ? `Allocatable: ${formatKubernetesBytes(node.allocatable.memory)}`
              : undefined
          }
        />

        <Section>
          <SectionHeader title="Pods (running)" />
          <div>
            <div className="text-2xl font-bold">{podCount ?? "-"}</div>
            <p className="text-xs text-muted-foreground">
              Allocatable:{" "}
              {node?.allocatable.pods || node?.capacity.pods || "-"}
            </p>
          </div>
        </Section>

        <Section>
          <SectionHeader title="Storage" />
          <div>
            <div className="text-2xl font-bold truncate text-lg">
              {node && formatKubernetesBytes(node.capacity.ephemeralStorage)}
            </div>
            <p className="text-xs text-muted-foreground truncate">
              Allocatable:{" "}
              {node && formatKubernetesBytes(node.allocatable.ephemeralStorage)}
            </p>
          </div>
        </Section>
      </div>

      {/* Debug Node Dialog */}
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
