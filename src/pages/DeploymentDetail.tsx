import { useEffect, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useLiveQuery } from "@/hooks/useLiveQuery";
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
import { TrafficChain } from "@/components/resources/TrafficChain";
import { connectionsTab } from "@/components/resources/connections-tab";
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
import { deliveryOfKind } from "@/lib/delivery";
import { scaleWarnings } from "@/lib/governance";
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
  DetailAction,
} from "@/components/resources/detail-blocks";
import { WorkloadUsage } from "@/components/resources/workload-usage";
import { serviceAccountRow } from "@/components/resources/identity-rows";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { useResourceMutation, useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useMetrics } from "@/hooks/useMetrics";
import { commands } from "@/lib/commands";
import { podContainers } from "@/lib/container-sequence";
import { normalizeTauriError } from "@/lib/error-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import type { DeploymentInfo } from "@/generated/types";
import { useT } from "@/i18n/useT";

export function DeploymentDetail() {
  const t = useT();
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
    freshness,
  } = useResourceDetail<DeploymentInfo>({
    resourceKind: ResourceType.Deployment,
    fetchResource: (name, ns) => commands.getDeployment(name, ns),
    deleteResource: (name, ns) => commands.deleteDeployment(name, ns),
    defaultTab: "overview",
  });

  const { data: pods = [] } = useLiveQuery({
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
    refresh: "resourceList",
    refetchOnWindowFocus: false,
  });

  const connections = useConnections(ResourceType.Deployment, name, namespace);

  const { data: revisions = [] } = useLiveQuery({
    queryKey: ["deployment-replicasets", namespace, name],
    queryFn: () => commands.getDeploymentReplicasets(name!, namespace || null),
    enabled: !!namespace && !!name,
    placeholderData: keepPreviousData,
    staleTime: STALE_TIMES.resourceList,
    refresh: "resourceList",
  });

  // For the banner only. The Usage block reads the same query through the
  // same key, so this costs one fetch between them.
  const { podStatus } = useMetrics({
    namespace: namespace || null,
    includeNodes: false,
    enabled: !!deployment,
  });

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

  const { data: rolloutStatus } = useLiveQuery({
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
    refresh: "fast",
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

  const deliveryQuery = deliveryOfKind(ResourceType.Deployment, deployment);
  const intercept = useDeliveryIntercept(deliveryQuery);

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
  const desired = replicas?.desired ?? 0;
  const ready = replicas?.ready ?? 0;

  // Desired, ready, available and up-to-date are one count read four ways, and
  // as four rows the reader had to subtract them to find the gap the bar shows
  // outright. The two the bar does not partition qualify it underneath.
  const facts: KeyValue[] = [
    { label: "Strategy", value: deployment?.strategy || "RollingUpdate" },
    serviceAccountRow(deployment?.serviceAccountName, deployment?.namespace),
  ];

  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: "Overview",
      glyph: viewGlyph(Info),
      content: (
        <>
          {podStatus?.status !== "available" && (
            <MetricsStatusBanner status={podStatus} />
          )}

          <WorkloadOverview
            count={
              <CountBlock title="Replicas" governance={connections}>
                <Composition
                  total={desired}
                  label={t("count", "replicasWanted", { n: desired })}
                  segments={[
                    { label: "ready", count: ready, tone: "ok" },
                    {
                      label: "not ready",
                      count: Math.max(0, desired - ready),
                      tone: "warn",
                    },
                  ]}
                  emptyMessage={t("empty", "scaledToZero")}
                  note={`${replicas?.updated ?? 0} up to date · ${replicas?.available ?? 0} available`}
                />
              </CountBlock>
            }
            usage={
              <WorkloadUsage
                kind={ResourceType.Deployment}
                uid={deployment?.uid}
                name={deployment?.name || name}
                namespace={deployment?.namespace || namespace}
                template={deployment}
                pods={pods}
                idle={
                  desired === 0
                    ? t("empty", "kindScaledToZero", {
                        kind: ResourceType.Deployment,
                      })
                    : t("empty", "kindNoPodsRunning", {
                        kind: ResourceType.Deployment,
                      })
                }
                connections={connections.data}
              />
            }
            traffic={<TrafficChain query={connections} />}
            declared={<FactBlock title="How it is declared" items={facts} />}
          >
            {deployment && (
              <RelatedResources
                ownerReferences={deployment.ownerReferences}
                namespace={deployment.namespace}
              />
            )}
          </WorkloadOverview>

          <KeyValueSection
            title="Labels"
            count={Object.keys(deployment?.labels ?? {}).length}
            items={recordToKeyValues(deployment?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title="Annotations"
            count={Object.keys(deployment?.annotations ?? {}).length}
            items={recordToKeyValues(deployment?.annotations ?? {})}
            emptyMessage={t("empty", "noAnnotations")}
          />
        </>
      ),
    },
    connectionsTab(connections, deliveryQuery),
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
                // The live half still reads one pod, because that is all the
                // API server will follow. The workload is what a *range* is
                // asked about — the pods this Deployment had an hour ago are
                // gone from this very selector, and they are the ones
                // somebody reading a rollout came for.
                workload={
                  name ? { owner: name, ownerKind: "Deployment" } : null
                }
              />
            ) : (
              <p className="py-8 text-center text-xs text-fg-fnt">
                {pods.length === 0
                  ? t("empty", "noPodsToReadLogs")
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
    <>
      <ResourceDetailLayout
        freshness={freshness}
        resource={deployment}
        delivery={deliveryQuery}
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
            <DetailAction
              label="Scale"
              icon={Scale}
              onClick={openScaleDialog}
            />
            <InterceptedAction
              intercept={intercept("Restart")}
              label="Restart"
              icon={RefreshCw}
              onClick={() => restartMutation.mutate()}
              busy={restartMutation.isPending}
            />
            <InterceptedAction
              intercept={intercept("Delete")}
              label="Delete"
              icon={Trash2}
              onClick={() => deleteMutation?.mutate()}
              busy={deleteMutation?.isPending}
              danger
            />
          </>
        }
        summary={
          isRolloutInProgress &&
          rolloutStatus && (
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
          )
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      {/* Both are opened from the strip's row, and so from whichever tab the
          reader is on. Inside the Overview's panel they would be unmounted the
          moment that tab was not the open one. */}
      <ScaleDialog
        warnings={scaleWarnings(connections.data, intercept("Scale"))}
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
    </>
  );
}
