import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { Section, SectionHeader } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import { commands } from "@/lib/commands";
import { useState, useEffect, useMemo } from "react";
import { useResourceMutation, useResourceDetail } from "@/hooks";
import { useMetrics } from "@/hooks/useMetrics";
import type { DeploymentInfo } from "@/generated/types";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { REFRESH_INTERVALS, STALE_TIMES } from "@/lib/refresh";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Trash2, RefreshCw, Scale, RotateCcw, Rocket } from "lucide-react";
import { LogViewer } from "@/components/logs/LogViewer";
import { MetricsStatusBanner } from "@/components/metrics";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { ConditionsDisplay } from "@/components/resources/ConditionsDisplay";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
import { ContainerCard } from "@/components/resources/ContainerCard";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { PodListCard } from "@/components/resources/PodListCard";
import { MetricCard } from "@/components/ui/metric-card";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  parseCPU as parseKubernetesCPU,
  parseMemory as parseKubernetesMemory,
} from "@/lib/k8s-quantity";
import { aggregatePodMetrics, mergePodsWithMetrics } from "@/lib/metrics";
import { normalizeTauriError } from "@/lib/error-utils";

export function DeploymentDetail() {
  const [scaleDialogOpen, setScaleDialogOpen] = useState(false);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [newReplicas, setNewReplicas] = useState(1);
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
        const result = await commands.getDeploymentPods(
          name,
          namespace || null
        );
        return result;
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

  // Get pod metrics for real-time updates
  const { podMetrics, podStatus } = useMetrics({
    namespace: namespace || null,
    includeNodes: false,
    includeCluster: false,
    enabled: !!deployment,
  });

  // Merge pods with metrics
  const podsWithMetrics = useMemo(() => {
    return mergePodsWithMetrics(pods, podMetrics);
  }, [pods, podMetrics]);

  // Calculate aggregated metrics for deployment
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

  // Get the currently selected pod for logs
  const logPod = pods.find((p) => p.name === selectedLogPod);

  // Calculate total CPU/Memory limits/requests from containers
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

    deployment.containers.forEach((c) => {
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
        const result = await commands.getRolloutStatus(name, namespace || null);
        return result;
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    enabled: !!namespace && !!name,
    refetchInterval: REFRESH_INTERVALS.fast,
  });

  const scaleMutation = useResourceMutation(
    async () => {
      if (!name) return;
      await commands.scaleDeployment(name, newReplicas, namespace || null);
    },
    {
      toast: {
        successTitle: "Deployment scaled",
        successDescription: `Deployment ${name} scaled to ${newReplicas} replicas.`,
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
    if (deployment) {
      setNewReplicas(deployment.replicas.desired);
      setScaleDialogOpen(true);
    }
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
    if (!rolloutStatus) {
      return null;
    }
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

  const tabs = [
    {
      id: "overview",
      label: "Overview",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Section>
              <SectionHeader title="Deployment Info" />
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Strategy</span>
                  <span>{deployment?.strategy || "RollingUpdate"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Replicas</span>
                  <span>{deployment?.replicas.desired}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Ready</span>
                  <span>{deployment?.replicas.ready}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Available</span>
                  <span>{deployment?.replicas.available}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Created</span>
                  <span>{deployment?.createdAt || "-"}</span>
                </div>
              </div>
            </Section>

            <LabelsDisplay labels={deployment?.labels || {}} title="Labels" />
          </div>

          {podStatus?.status !== "available" && (
            <MetricsStatusBanner status={podStatus} />
          )}
          {/* Resource Usage Metrics */}
          <div className="grid grid-cols-2 gap-4">
            <MetricCard
              title="CPU Usage"
              used={aggregatedMetrics.cpuMillicores}
              request={totalResources.cpuRequest}
              limit={totalResources.cpuLimit}
              type="cpu"
              showProgressBar
            />
            <MetricCard
              title="Memory Usage"
              used={aggregatedMetrics.memoryBytes}
              request={totalResources.memoryRequest}
              limit={totalResources.memoryLimit}
              type="memory"
              showProgressBar
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Aggregated across {podsWithMetrics.length} pod
            {podsWithMetrics.length !== 1 ? "s" : ""}
          </p>
        </div>
      ),
    },
    {
      id: "container-template",
      label: "Container Template",
      content: (
        <div className="space-y-4">
          {(deployment?.containers || []).map((container) => (
            <ContainerCard
              key={container.name}
              container={container}
              namespace={namespace}
              showUpdateImage={true}
              onUpdateImage={openImageDialog}
            />
          ))}
        </div>
      ),
    },
    {
      id: toPlural(ResourceType.Pod),
      label: "Pods",
      content: <PodListCard pods={pods} />,
    },
    {
      id: "logs",
      label: "Logs",
      content: (
        <Section className="h-[600px]">
          <SectionHeader
            title="Pod Logs"
            actions={
              <Select
                value={selectedLogPod || ""}
                onValueChange={setSelectedLogPod}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="Select pod" />
                </SelectTrigger>
                <SelectContent>
                  {pods.map((pod) => {
                    const status = pod.status?.phase || "Unknown";
                    return (
                      <SelectItem key={pod.name} value={pod.name}>
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${
                              status === "Running"
                                ? "bg-ok"
                                : status === "Pending"
                                  ? "bg-warn"
                                  : "bg-err"
                            }`}
                          />
                          {pod.name}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            }
          />
          <div className="p-0 h-[calc(100%-4rem)]">
            {logPod ? (
              <LogViewer
                key={`${logPod.namespace}:${logPod.name}`}
                podName={logPod.name}
                namespace={logPod.namespace}
                containers={logPod.containers?.map((c) => c.name) || []}
                initialContainer={logPod.containers?.[0]?.name}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                {pods.length === 0
                  ? "No pods available for this deployment"
                  : "Select a pod to view logs"}
              </div>
            )}
          </div>
        </Section>
      ),
    },
    {
      id: "yaml",
      label: "YAML",
      content: (
        <YamlTabContent
          title="Deployment YAML"
          yaml={deploymentYaml}
          resourceKind={ResourceType.Deployment}
          resourceName={name || ""}
          namespace={namespace}
          onCopy={copyYaml}
        />
      ),
    },
    {
      id: "conditions",
      label: "Conditions",
      content: (
        <ConditionsDisplay
          conditions={deployment?.conditions || []}
          title="Deployment Conditions"
        />
      ),
    },
  ];

  return (
    <ResourceDetailLayout
      resource={deployment}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Deployment}
      title={deployment?.name || ""}
      namespace={deployment?.namespace}
      badges={
        deployment && (
          <>
            <Badge
              variant={
                deployment.replicas.ready === deployment.replicas.desired
                  ? "success"
                  : "warning"
              }
            >
              {deployment.replicas.ready}/{deployment.replicas.desired} pods
              ready
            </Badge>
            {isRolloutInProgress && (
              <Badge variant="secondary" className="animate-pulse">
                <RotateCcw className="mr-1 h-3 w-3 animate-spin" />
                Rolling out...
              </Badge>
            )}
          </>
        )
      }
      icon={<Rocket className="h-8 w-8 text-muted-foreground" />}
      onBack={goBack}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={openScaleDialog}>
            <Scale className="mr-2 h-4 w-4" />
            Scale
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => restartMutation.mutate()}
            disabled={restartMutation.isPending}
          >
            <RefreshCw
              className={cn(
                "mr-2 h-4 w-4",
                restartMutation.isPending && "animate-spin"
              )}
            />
            Restart
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => deleteMutation && deleteMutation.mutate()}
            disabled={deleteMutation?.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </>
      }
      tabs={tabs}
      activeTab={activeTab}
      onTabChange={setActiveTab}
    >
      {/* Rollout Progress */}
      {isRolloutInProgress && rolloutStatus && (
        <Section className="border-blue-500/50 bg-blue-500/10 mb-4">
          <div className="py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm">{rolloutMessage}</span>
              <span className="text-sm text-muted-foreground">
                {rolloutReady}/{rolloutDesired} pods ready
              </span>
            </div>
          </div>
        </Section>
      )}

      {/* Info Cards (Optional, current deployment view has mostly overview tab info) */}
      {/* If there were specific high-level metrics cards they would go here */}

      {/* Related Resources (Owner References) */}
      {deployment && (
        <RelatedResources
          ownerReferences={deployment.ownerReferences}
          namespace={deployment.namespace}
        />
      )}

      {/* Scale Dialog */}
      <Dialog open={scaleDialogOpen} onOpenChange={setScaleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Scale Deployment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="replicas">Number of replicas</Label>
              <Input
                id="replicas"
                type="number"
                min={0}
                value={newReplicas}
                onChange={(e) => setNewReplicas(parseInt(e.target.value) || 0)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setScaleDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => scaleMutation.mutate()}
              disabled={scaleMutation.isPending}
            >
              Scale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Update Image Dialog */}
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
