import { useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  AlignLeft,
  BadgeCheck,
  Info,
  Layers2,
  RefreshCw,
  Scale,
  Trash2,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { LogViewer } from "@/components/logs/LogViewer";
import { MetricsStatusBanner } from "@/components/metrics";
import { yamlTab } from "@/components/resources/yaml-tab";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { PodListCard } from "@/components/resources/PodListCard";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  conditionsMark,
  countMark,
  kindGlyph,
  podsMark,
  viewGlyph,
  type DetailTab,
} from "@/components/resources/detail-tab";
import { RevisionRows } from "@/components/resources/child-rows";
import { ResourceMessage } from "@/components/resources/ResourceMessage";
import { ScaleDialog } from "@/components/resources/ScaleDialog";
import { ContainerRows } from "@/components/resources/container-rows";
import { declaredContainers } from "@/lib/container-sequence";
import {
  ConditionRows,
  DetailAction,
  UsageRow,
} from "@/components/resources/detail-blocks";
import { serviceAccountRow } from "@/components/resources/identity-rows";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceMutation, useResourceDetail } from "@/hooks";
import { useMetrics } from "@/hooks/useMetrics";
import { commands } from "@/lib/commands";
import { podContainers } from "@/lib/container-sequence";
import { normalizeTauriError } from "@/lib/error-utils";
import {
  parseCPU as parseKubernetesCPU,
  parseMemory as parseKubernetesMemory,
} from "@/lib/k8s-quantity";
import { aggregatePodMetrics, mergePodsWithMetrics } from "@/lib/metrics";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { DeploymentInfo } from "@/generated/types";

export function DeploymentDetail() {
  const [scaleDialogOpen, setScaleDialogOpen] = useState(false);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [newImage, setNewImage] = useState("");
  const [selectedContainer, setSelectedContainer] = useState("");
  const [selectedLogPod, setSelectedLogPod] = useState<string | null>(null);
  const {
    name,
    namespace,
    resource: deployment,
    isLoading,
    error,
    yaml: deploymentYaml,
    copyYaml,
    activeTab,
    setActiveTab,
    goBack,
    deleteMutation,
  } = useResourceDetail<DeploymentInfo>({
    resourceKind: ResourceType.Deployment,
    fetchResource: (name, ns) => commands.getDeployment(name, ns),
    deleteResource: (name, ns) => commands.deleteDeployment(name, ns),
    defaultTab: "overview",
  });

  const { data: pods = [] } = useQuery({
    queryKey: ["deployment-pods", namespace, name],
    queryFn: async () => {
      try {
        if (!name) return [];
        return await commands.getDeploymentPods(name, namespace || null);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
    refetchOnWindowFocus: false,
  });

  const { data: revisions = [] } = useQuery({
    queryKey: ["deployment-replicasets", namespace, name],
    queryFn: () => commands.getDeploymentReplicasets(name!, namespace || null),
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refetchInterval: REFRESH_INTERVALS.resourceList,
  });

  const { podMetrics, podStatus } = useMetrics({
    namespace: namespace || null,
    includeNodes: false,
    includeCluster: false,
    enabled: !!deployment,
  });

  const podsWithMetrics = useMemo(() => {
    return mergePodsWithMetrics(pods, podMetrics);
  }, [pods, podMetrics]);

  const aggregatedMetrics = useMemo(() => {
    return aggregatePodMetrics(podsWithMetrics);
  }, [podsWithMetrics]);

  // Auto-select first pod for logs when pods load. Genuine
  // sync-async-data-into-local-state — could be derived as
  // `selectedLogPod ?? pods[0]?.name` at use sites, but the user
  // can also explicitly pick a different pod via the dropdown,
  // and that user choice has to win over auto-selection.
  useEffect(() => {
    if (pods.length > 0 && !selectedLogPod) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedLogPod(pods[0].name);
    }
  }, [pods, selectedLogPod]);

  const logPod = pods.find((p) => p.name === selectedLogPod);

  // The template declares per-replica amounts; the usage measured below is
  // the sum over every replica, so the ceiling has to be scaled to match.
  const totalResources = useMemo(() => {
    if (!deployment?.containers)
      return {
        cpuLimit: null,
        cpuRequest: null,
        memoryLimit: null,
        memoryRequest: null,
      };

    const replicas = deployment.replicas.desired || 1;
    let totalCpuLimits = 0;
    let totalCpuRequests = 0;
    let totalMemoryLimits = 0;
    let totalMemoryRequests = 0;

    // Sidecars, not just app containers: a native sidecar runs for the
    // life of the pod, so the scheduler adds its request to the app
    // containers' and the ceiling this chart draws has to match. An
    // ordinary init container has exited before any of this is measured.
    const sustained = declaredContainers(deployment).filter(
      (c) => c.phase !== "init"
    );

    sustained.forEach((c) => {
      if (c.resources?.limits?.cpu) {
        totalCpuLimits += parseKubernetesCPU(c.resources.limits.cpu);
      }
      if (c.resources?.requests?.cpu) {
        totalCpuRequests += parseKubernetesCPU(c.resources.requests.cpu);
      }
      if (c.resources?.limits?.memory) {
        totalMemoryLimits += parseKubernetesMemory(c.resources.limits.memory);
      }
      if (c.resources?.requests?.memory) {
        totalMemoryRequests += parseKubernetesMemory(
          c.resources.requests.memory
        );
      }
    });

    return {
      cpuLimit: totalCpuLimits > 0 ? totalCpuLimits * replicas : null,
      cpuRequest: totalCpuRequests > 0 ? totalCpuRequests * replicas : null,
      memoryLimit: totalMemoryLimits > 0 ? totalMemoryLimits * replicas : null,
      memoryRequest:
        totalMemoryRequests > 0 ? totalMemoryRequests * replicas : null,
    };
  }, [deployment]);

  const { data: rolloutStatus } = useQuery({
    queryKey: ["rollout-status", namespace, name],
    queryFn: async () => {
      try {
        if (!name) return null;
        return await commands.getRolloutStatus(name, namespace || null);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!namespace && !!name,
    refetchInterval: REFRESH_INTERVALS.fast,
  });

  const scaleMutation = useResourceMutation(
    async (replicas: number) => {
      if (!name) return;
      await commands.scaleDeployment(name, replicas, namespace || null);
    },
    {
      toast: {
        successTitle: "Deployment scaled",
        successDescription: (_data, replicas) =>
          `Deployment ${name} scaled to ${replicas} replicas.`,
        errorPrefix: "Failed to scale deployment",
      },
      invalidateQueryKeys:
        namespace && name ? [["deployment", namespace, name]] : [],
      onSuccess: () => {
        setScaleDialogOpen(false);
      },
    }
  );

  const restartMutation = useResourceMutation(
    async () => {
      if (!name || !namespace) return;
      await commands.restartDeployment(name, namespace);
    },
    {
      toast: {
        successTitle: "Deployment restarted",
        successDescription: `Deployment ${name} is being restarted.`,
        errorPrefix: "Failed to restart deployment",
      },
      invalidateQueryKeys:
        name && namespace ? [["deployment", namespace, name]] : [],
    }
  );

  const updateImageMutation = useResourceMutation(
    async () => {
      if (!name || !namespace) return;
      await commands.updateDeploymentImage(
        name,
        selectedContainer,
        newImage,
        namespace
      );
    },
    {
      toast: {
        successTitle: "Image updated",
        successDescription: `Container ${selectedContainer} image updated to ${newImage}.`,
        errorPrefix: "Failed to update image",
      },
      invalidateQueryKeys:
        name && namespace ? [["deployment", namespace, name]] : [],
      onSuccess: () => {
        setImageDialogOpen(false);
      },
    }
  );

  const openScaleDialog = () => {
    if (deployment) setScaleDialogOpen(true);
  };

  const openImageDialog = (containerName: string, currentImage: string) => {
    setSelectedContainer(containerName);
    setNewImage(currentImage);
    setImageDialogOpen(true);
  };

  if (!deployment && !isLoading && !error) {
    return null;
  }

  const rolloutDesired =
    rolloutStatus?.replicas ?? deployment?.replicas.desired ?? 0;
  const rolloutReady =
    rolloutStatus?.readyReplicas ?? deployment?.replicas.ready ?? 0;
  const rolloutUpdated =
    rolloutStatus?.updatedReplicas ?? deployment?.replicas.updated ?? 0;
  const rolloutAvailable =
    rolloutStatus?.availableReplicas ?? deployment?.replicas.available ?? 0;
  const isRolloutInProgress =
    rolloutStatus !== undefined &&
    !(
      rolloutUpdated >= rolloutDesired &&
      rolloutAvailable >= rolloutDesired &&
      rolloutReady >= rolloutDesired
    );

  const rolloutMessage = (() => {
    if (!rolloutStatus) return null;
    const progressing = rolloutStatus.conditions.find(
      (c) => c.conditionType === "Progressing"
    );
    const available = rolloutStatus.conditions.find(
      (c) => c.conditionType === "Available"
    );
    if (isRolloutInProgress) {
      return (
        progressing?.message ||
        progressing?.reason ||
        "Rolling out new replica set"
      );
    }
    return available?.message || "Deployment is available";
  })();

  const replicas = deployment?.replicas;
  const shortReplicas = !!replicas && replicas.ready < replicas.desired;

  const facts: KeyValue[] = [
    { label: "Strategy", value: deployment?.strategy || "RollingUpdate" },
    { label: "Desired", value: replicas?.desired ?? 0, mono: true },
    {
      label: "Ready",
      value: replicas?.ready ?? 0,
      mono: true,
      tone: shortReplicas ? "warn" : undefined,
    },
    { label: "Available", value: replicas?.available ?? 0, mono: true },
    { label: "Up to date", value: replicas?.updated ?? 0, mono: true },
    {
      label: "Containers",
      value: deployment ? declaredContainers(deployment).length : 0,
      mono: true,
    },
    serviceAccountRow(deployment?.serviceAccountName, deployment?.namespace),
  ];

  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          <KeyValueSection
            title="Labels"
            count={Object.keys(deployment?.labels ?? {}).length}
            items={recordToKeyValues(deployment?.labels ?? {})}
            emptyMessage="No labels"
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(deployment?.annotations ?? {}).length}
            items={recordToKeyValues(deployment?.annotations ?? {})}
            emptyMessage="No annotations"
          />
        </>
      ),
    },
    {
      id: "container-template",
      label: "Template",
      glyph: viewGlyph(Layers2),
      content: (
        <ContainerRows
          template={deployment}
          namespace={namespace}
          onUpdateImage={openImageDialog}
        />
      ),
    },
    {
      id: toPlural(ResourceType.Pod),
      label: "Pods",
      glyph: kindGlyph(ResourceType.Pod),
      mark: podsMark(pods),
      content: <PodListCard pods={pods} />,
    },
    {
      id: toPlural(ResourceType.ReplicaSet),
      label: "Revisions",
      glyph: kindGlyph(ResourceType.ReplicaSet),
      // A count rather than a severity: an old revision at zero is what a
      // rollout leaves behind, not a fault.
      mark: countMark(revisions.length),
      content: <RevisionRows revisions={revisions} />,
    },
    {
      id: "logs",
      label: "Logs",
      glyph: viewGlyph(AlignLeft),
      kind: "surface",
      content: (
        <div className="flex h-full flex-col">
          <SectionHeader
            className="flex-none pb-2"
            title="Logs"
            actions={
              <Select
                value={selectedLogPod || ""}
                onValueChange={setSelectedLogPod}
              >
                <SelectTrigger
                  aria-label="Pod"
                  className="h-6 w-56 gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
                >
                  <SelectValue placeholder="Select pod" />
                </SelectTrigger>
                <SelectContent>
                  {pods.map((pod) => {
                    const phase = pod.status?.display || "Unknown";
                    return (
                      <SelectItem key={pod.name} value={pod.name}>
                        <span className="flex items-center gap-2">
                          <span className="font-mono">{pod.name}</span>
                          <StatusBadge status={phase} showDot />
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            }
          />
          <div className="min-h-0 flex-1 border-t border-hair">
            {logPod ? (
              <LogViewer
                key={`${logPod.namespace}:${logPod.name}`}
                podName={logPod.name}
                namespace={logPod.namespace}
                containers={podContainers(logPod)}
              />
            ) : (
              <p className="py-8 text-center text-xs text-fg-fnt">
                {pods.length === 0
                  ? "This deployment has no pods to read logs from."
                  : "Select a pod to view logs"}
              </p>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "conditions",
      label: "Conditions",
      glyph: viewGlyph(BadgeCheck),
      mark: conditionsMark(deployment?.conditions),
      content: (
        <Section>
          <SectionHeader
            title="Conditions"
            count={deployment?.conditions.length}
          />
          <ConditionRows
            conditions={deployment?.conditions ?? []}
            subject={{ kind: ResourceType.Deployment, name, namespace }}
          />
        </Section>
      ),
    },
    yamlTab({
      title: "Deployment YAML",
      yaml: deploymentYaml,
      resourceKind: ResourceType.Deployment,
      resourceName: name || "",
      namespace,
      onCopy: copyYaml,
    }),
  ];

  return (
    <ResourceDetailLayout
      resource={deployment}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Deployment}
      title={deployment?.name || ""}
      namespace={deployment?.namespace}
      createdAt={deployment?.createdAt}
      statusBadge={
        replicas && (
          <StatusBadge status={shortReplicas ? "Degraded" : "Available"}>
            {replicas.ready}/{replicas.desired} ready
          </StatusBadge>
        )
      }
      badges={
        isRolloutInProgress && (
          <span className="text-[11px] text-info">rolling out</span>
        )
      }
      onBack={goBack}
      actions={
        <>
          <DetailAction label="Scale" icon={Scale} onClick={openScaleDialog} />
          <DetailAction
            label="Restart"
            icon={RefreshCw}
            onClick={() => restartMutation.mutate()}
            busy={restartMutation.isPending}
          />
          <DetailAction
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
    >
      {isRolloutInProgress && rolloutStatus && (
        <p className="text-[11px] text-info">
          <ResourceMessage
            message={rolloutMessage ?? ""}
            subject={{ kind: ResourceType.Deployment, name, namespace }}
          />
          <span className="text-fg-fnt">
            {" "}
            · {rolloutReady}/{rolloutDesired} pods ready
          </span>
        </p>
      )}

      {podStatus?.status !== "available" && (
        <MetricsStatusBanner status={podStatus} />
      )}

      <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
        <KeyValueSection title="Rollout" items={facts} />
        <Section>
          <SectionHeader
            title="Usage"
            count={`summed over ${podsWithMetrics.length} pod${
              podsWithMetrics.length === 1 ? "" : "s"
            } · against declared limits`}
          />
          <div>
            <UsageRow
              label="CPU"
              used={aggregatedMetrics.cpuMillicores}
              total={totalResources.cpuLimit}
              type="cpu"
            />
            <UsageRow
              label="Memory"
              used={aggregatedMetrics.memoryBytes}
              total={totalResources.memoryLimit}
              type="memory"
            />
          </div>
        </Section>
      </div>

      {deployment && (
        <RelatedResources
          ownerReferences={deployment.ownerReferences}
          namespace={deployment.namespace}
        />
      )}

      <ScaleDialog
        open={scaleDialogOpen}
        onOpenChange={setScaleDialogOpen}
        kind={ResourceType.Deployment}
        current={deployment?.replicas.desired ?? 0}
        busy={scaleMutation.isPending}
        onSubmit={(replicas) => scaleMutation.mutate(replicas)}
      />

      <Dialog open={imageDialogOpen} onOpenChange={setImageDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Update Container Image</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Container</Label>
              <Input value={selectedContainer} disabled />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image">New Image</Label>
              <Input
                id="image"
                value={newImage}
                onChange={(e) => setNewImage(e.target.value)}
                placeholder="e.g., nginx:1.21"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImageDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => updateImageMutation.mutate()}
              disabled={updateImageMutation.isPending || !newImage}
            >
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ResourceDetailLayout>
  );
}
