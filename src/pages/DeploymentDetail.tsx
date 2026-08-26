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
import { podToShow } from "@/lib/pod-selection";
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

  const { data: pods = [], error: podsError } = useLiveQuery({
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

  // The chosen pod has to be one of this workload's pods. Genuine
  // sync-async-data-into-local-state — it could be derived as
  // `selectedLogPod ?? pods[0]?.name` at use sites, but the reader can pick
  // a different pod from the dropdown and that choice has to win over the
  // automatic one.
  //
  // The condition used to be `!selectedLogPod`, which only ever ran once.
  // Walk to another Deployment, or watch the chosen pod get rolled away, and
  // the name stayed pointing at a pod this list no longer has: `logPod` came
  // back undefined, the Logs tab rendered nothing, and the effect that would
  // have fixed it was gated on the very value that was wrong. Nothing short
  // of a reload recovered. Membership rather than emptiness, so a selection
  // that has gone stale is replaced instead of kept.
  useEffect(() => {
    const shown = podToShow(pods, selectedLogPod);
    if (shown === selectedLogPod) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedLogPod(shown);
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
        successTitle: t("action", "kindScaled", {
          kind: ResourceType.Deployment,
        }),
        successDescription: (_data, replicas) =>
          t("action", "kindScaledDetail", {
            kind: ResourceType.Deployment,
            name: name ?? "",
            n: replicas,
          }),
        errorPrefix: t("action", "scaleKindFailed", {
          kind: ResourceType.Deployment,
        }),
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
        successTitle: t("action", "kindRestarted", {
          kind: ResourceType.Deployment,
        }),
        successDescription: t("action", "kindRestartingDetail", {
          kind: ResourceType.Deployment,
          name: name ?? "",
        }),
        errorPrefix: t("action", "restartKindFailed", {
          kind: ResourceType.Deployment,
        }),
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
        successTitle: t("action", "imageUpdated"),
        successDescription: t("action", "imageUpdatedDetail", {
          container: selectedContainer,
          image: newImage,
        }),
        errorPrefix: t("action", "updateImageFailed"),
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
        t("action", "rollingOutNewReplicaSet")
      );
    }
    return available?.message || t("action", "deploymentAvailable");
  })();

  const replicas = deployment?.replicas;
  const shortReplicas = !!replicas && replicas.ready < replicas.desired;
  const desired = replicas?.desired ?? 0;
  const ready = replicas?.ready ?? 0;

  // Desired, ready, available and up-to-date are one count read four ways, and
  // as four rows the reader had to subtract them to find the gap the bar shows
  // outright. The two the bar does not partition qualify it underneath.
  const facts: KeyValue[] = [
    {
      label: t("columns", "strategy"),
      value: deployment?.strategy || "RollingUpdate",
    },
    serviceAccountRow(deployment?.serviceAccountName, deployment?.namespace),
  ];

  const tabs: DetailTab[] = [
    {
      id: "overview",
      label: t("nav", "overview"),
      glyph: viewGlyph(Info),
      content: (
        <>
          {podStatus?.status !== "available" && (
            <MetricsStatusBanner status={podStatus} />
          )}

          <WorkloadOverview
            count={
              <CountBlock
                title={t("columns", "replicas")}
                governance={connections}
              >
                <Composition
                  total={desired}
                  label={t("count", "replicasWanted", { n: desired })}
                  segments={[
                    {
                      label: t("count", "readyWord"),
                      count: ready,
                      tone: "ok",
                    },
                    {
                      label: t("count", "notReadyWord"),
                      count: Math.max(0, desired - ready),
                      tone: "warn",
                    },
                  ]}
                  emptyMessage={t("empty", "scaledToZero")}
                  note={t("count", "upToDateAvailable", {
                    updated: replicas?.updated ?? 0,
                    available: replicas?.available ?? 0,
                  })}
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
            declared={
              <FactBlock title={t("nav", "howDeclared")} items={facts} />
            }
          >
            {deployment && (
              <RelatedResources
                ownerReferences={deployment.ownerReferences}
                namespace={deployment.namespace}
              />
            )}
          </WorkloadOverview>

          <KeyValueSection
            title={t("columns", "labels")}
            count={Object.keys(deployment?.labels ?? {}).length}
            items={recordToKeyValues(deployment?.labels ?? {})}
            emptyMessage={t("empty", "noLabels")}
          />
          <KeyValueSection
            title={t("columns", "annotations")}
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
      label: t("nav", "template"),
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
      content: <PodListCard pods={pods} error={podsError} />,
    },
    {
      id: toPlural(ResourceType.ReplicaSet),
      label: t("nav", "revisions"),
      glyph: kindGlyph(ResourceType.ReplicaSet),
      // A count rather than a severity: an old revision at zero is what a
      // rollout leaves behind, not a fault.
      mark: countMark(revisions.length),
      content: <RevisionRows revisions={revisions} />,
    },
    {
      id: "logs",
      label: t("action", "logs"),
      glyph: viewGlyph(AlignLeft),
      kind: "surface",
      content: (
        <div className="flex h-full flex-col">
          <SectionHeader
            className="flex-none pb-2"
            title={t("action", "logs")}
            actions={
              <Select
                value={selectedLogPod || ""}
                onValueChange={setSelectedLogPod}
              >
                <SelectTrigger
                  aria-label="Pod"
                  className="h-6 w-56 gap-1 border-0 bg-transparent px-1.5 text-[11px] text-fg-mut hover:bg-hover focus:ring-0 focus:ring-offset-0"
                >
                  <SelectValue placeholder={t("action", "selectPod")} />
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
                  : t("empty", "selectPodForLogs")}
              </p>
            )}
          </div>
        </div>
      ),
    },
    {
      id: "conditions",
      label: t("nav", "conditions"),
      glyph: viewGlyph(BadgeCheck),
      mark: conditionsMark(deployment?.conditions),
      content: (
        <Section>
          <SectionHeader
            title={t("nav", "conditions")}
            count={deployment?.conditions.length || undefined}
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
              {t("count", "slashReady", {
                n: replicas.ready,
                total: replicas.desired,
              })}
            </StatusBadge>
          )
        }
        badges={
          isRolloutInProgress && (
            <span className="text-[11px] text-info">
              {t("action", "rollingOut")}
            </span>
          )
        }
        onBack={goBack}
        actions={
          <>
            <DetailAction
              label={t("action", "scale")}
              icon={Scale}
              onClick={openScaleDialog}
            />
            <InterceptedAction
              intercept={intercept("Restart")}
              label={t("action", "restart")}
              icon={RefreshCw}
              onClick={() => restartMutation.mutate()}
              busy={restartMutation.isPending}
            />
            <InterceptedAction
              intercept={intercept("Delete")}
              label={t("action", "delete")}
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
                ·{" "}
                {t("count", "podsReadySlash", {
                  n: rolloutReady,
                  total: rolloutDesired,
                })}
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
        warnings={scaleWarnings(connections.data, intercept("Scale"), t)}
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
            <DialogTitle>{t("action", "updateContainerImage")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("columns", "container")}</Label>
              <Input value={selectedContainer} disabled />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image">{t("action", "newImage")}</Label>
              <Input
                id="image"
                value={newImage}
                onChange={(e) => setNewImage(e.target.value)}
                placeholder={t("action", "imagePlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImageDialogOpen(false)}>
              {t("action", "cancel")}
            </Button>
            <Button
              onClick={() => updateImageMutation.mutate()}
              disabled={updateImageMutation.isPending || !newImage}
            >
              {t("action", "update")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
