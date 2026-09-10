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
  History,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
// The one place that turns replica counts into a word. This page kept a
// fourth, hand-rolled comparison with no zero case, so a Deployment
// scaled to nothing wore a green "Available" here and a grey "Idle" in
// the list and the peek beside it.
import { workloadStatus } from "@/lib/workload-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { LogViewer } from "@/components/logs/LogViewer";
import { useAsk } from "@/hooks/useAsk";
import type { After } from "@/lib/tell-me-when";
import { lanePodOf } from "@/components/logs/lanes";
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
import { ChangesTab } from "@/components/changes/ChangesTab";
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
import { useCriticalGate } from "@/hooks/useCriticalGate";
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
import { PinAction } from "@/components/services/PinAction";
import { useResourceMutation, useResourceDetail } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useMetrics } from "@/hooks/useMetrics";
import { commands } from "@/lib/commands";
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
  // Updating a container image rolls out new code — a change to the cluster,
  // gated on a critical one exactly like Scale, Restart and Delete beside it.
  const imageGate = useCriticalGate();
  const imageGateReset = imageGate.reset;
  useEffect(() => {
    if (!imageDialogOpen) imageGateReset();
  }, [imageDialogOpen, imageGateReset]);
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

  // Every action here is followed for two minutes and answered: rolled
  // out, failed, or no answer. The generation the page saw before the
  // click is what the answer is measured against.
  const asking = useAsk();
  const generationNow = deployment?.generation ?? null;
  const follow = (after: After) => {
    if (!name) return;
    asking.ask(
      { kind: "Deployment", namespace: namespace || null, name },
      after
    );
  };

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
      onSuccess: (_data, replicas) => {
        setScaleDialogOpen(false);
        follow({ action: "scale", replicas, generationBefore: generationNow });
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
      onSuccess: () =>
        follow({
          action: "restart",
          replicas: null,
          generationBefore: generationNow,
        }),
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
        follow({
          action: "image",
          replicas: null,
          generationBefore: generationNow,
        });
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
    serviceAccountRow(deployment?.serviceAccountName, deployment?.namespace, t),
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
    connectionsTab(connections, t, deliveryQuery),
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
      id: "changes",
      label: t("changes", "title"),
      glyph: viewGlyph(History),
      content: deployment ? (
        <ChangesTab
          subject={{
            kind: "Deployment",
            name: deployment.name,
            namespace: deployment.namespace,
            labels: deployment.labels,
            annotations: deployment.annotations,
          }}
        />
      ) : null,
    },
    {
      id: "logs",
      label: t("action", "logs"),
      glyph: viewGlyph(AlignLeft),
      kind: "surface",
      content: (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">
            <LogViewer
              key={`${namespace}/${name}`}
              namespace={namespace || ""}
              pods={pods.map(lanePodOf)}
              laneRule="pod"
              workload={name ? { owner: name, ownerKind: "Deployment" } : null}
            />
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
      title: t("action", "kindYaml", { kind: "Deployment" }),
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
            <StatusBadge status={workloadStatus(replicas)}>
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
            <PinAction kind="Deployment" namespace={namespace} name={name} />
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
            {imageGate.notice}
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
            {imageGate.input}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImageDialogOpen(false)}>
              {t("action", "cancel")}
            </Button>
            <Button
              onClick={() => updateImageMutation.mutate()}
              disabled={
                updateImageMutation.isPending || !newImage || imageGate.blocked
              }
            >
              {t("action", "update")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {asking.dialog}
    </>
  );
}
