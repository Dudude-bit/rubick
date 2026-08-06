import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bug, Network, RefreshCw, Trash2 } from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { MetricsStatusBanner } from "@/components/metrics";
import { DebugPodDialog } from "@/components/debug";
import { LogViewer } from "@/components/logs/LogViewer";
import { PodTerminal } from "@/components/terminal/PodTerminal";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { ContainerRows } from "@/components/resources/container-rows";
import {
  ConditionRows,
  DetailAction,
  UsageRow,
} from "@/components/resources/detail-blocks";
import { ResourceRef } from "@/components/resources/ResourceRef";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { PodPortForwardDialog } from "@/components/pod/PodPortForwardDialog";
import { usePodPortForward } from "@/components/pod/usePodPortForward";
import { usePodReplacementSearch } from "@/components/pod/usePodReplacementSearch";
import { useMetrics, useResourceDetail, useClusterInfo } from "@/hooks";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { mergePodsWithMetrics } from "@/lib/metrics";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import type { PodInfo, DebugResult } from "@/generated/types";

export function PodDetail() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentContext } = useClusterStore();
  const queryClient = useQueryClient();
  const { data: clusterInfo } = useClusterInfo();

  const [showTerminal, setShowTerminal] = useState(false);
  const [selectedContainer, setSelectedContainer] = useState<string | null>(
    null
  );
  const [debugDialogOpen, setDebugDialogOpen] = useState(false);

  const {
    resource: pod,
    isLoading,
    error,
    name,
    namespace,
    yaml,
    activeTab,
    setActiveTab,
    refetch,
    copyYaml,
    deleteMutation,
  } = useResourceDetail<PodInfo>({
    resourceKind: ResourceType.Pod,
    fetchResource: (name, namespace) => commands.getPod(name, namespace),
    deleteResource: (name, namespace) =>
      commands.deletePod(name, namespace, null),
  });

  const {
    savedLabels,
    isSearching: isSearchingReplacement,
    findReplacement,
  } = usePodReplacementSearch(pod, name, namespace);

  const {
    open: portForwardOpen,
    setOpen: setPortForwardOpen,
    openDialog: openPortForwardDialog,
    form: portForwardForm,
    setForm: setPortForwardForm,
    busy: portForwardBusy,
    handleSubmit: handlePortForward,
    handleStopSession: handleStopPortForward,
    activePortForwards,
    portForwardStatusBySession,
  } = usePodPortForward(pod);

  const { podMetrics, podStatus } = useMetrics({
    namespace: namespace || null,
    includeNodes: false,
    includeCluster: false,
    enabled: !!pod,
  });

  const podWithMetrics = useMemo(() => {
    if (!pod) return null;
    return mergePodsWithMetrics([pod], podMetrics)[0] ?? null;
  }, [pod, podMetrics]);

  const restartMutation = useMutation({
    mutationFn: async () => {
      if (!name) return;
      try {
        await commands.restartPod(name, namespace || null);
      } catch (err) {
        throw new Error(normalizeTauriError(err), { cause: err });
      }
    },
    onSuccess: () => {
      toast({
        title: "Pod restarted",
        description: `Pod ${name} is being restarted.`,
      });
      queryClient.invalidateQueries({ queryKey: ["pod", namespace, name] });
      refetch();
    },
    onError: (err) => {
      toast({
        title: "Error",
        description: `Failed to restart pod: ${err}`,
        variant: "destructive",
      });
    },
  });

  const openTerminal = (containerName: string) => {
    setSelectedContainer(containerName);
    setShowTerminal(true);
  };

  const handleDebugStart = (result: DebugResult) => {
    if (result.isNewPod) {
      navigate(
        `/${toPlural(ResourceType.Pod)}/${result.namespace}/${result.podName}`,
        { replace: false }
      );
    } else {
      setSelectedContainer(result.containerName);
      setShowTerminal(true);
    }
  };

  // Debug pods (created by copy/node debug) get a delete-now reminder
  // when the terminal closes — they keep running otherwise.
  const isDebugPod = pod?.labels?.["k8s-gui/debug-pod"] === "true";

  const handleTerminalClose = useCallback(() => {
    setShowTerminal(false);

    if (isDebugPod && pod) {
      toast({
        title: "Debug pod still running",
        description: "Delete when done to free cluster resources",
        action: (
          <Button
            size="sm"
            variant="destructive"
            onClick={async () => {
              try {
                await commands.deleteDebugPod(pod.name, pod.namespace);
                toast({ title: "Debug pod deleted", description: pod.name });
                navigate(-1);
              } catch (err) {
                toast({
                  title: "Failed to delete",
                  description: normalizeTauriError(err),
                  variant: "destructive",
                });
              }
            }}
          >
            Delete Now
          </Button>
        ),
        duration: 10000,
      });
    }
  }, [isDebugPod, pod, toast, navigate]);

  const handleFindReplacement = savedLabels
    ? () =>
        findReplacement().then((replacement) => {
          if (replacement) {
            toast({
              title: "Found replacement pod",
              description: `Switching to ${replacement.name}`,
            });
            navigate(
              `/${toPlural(ResourceType.Pod)}/${replacement.namespace}/${replacement.name}`,
              { replace: true }
            );
          } else {
            toast({
              title: "No replacement found",
              description: "No other running pods with matching labels",
              variant: "destructive",
            });
          }
        })
    : undefined;

  const placement: KeyValue[] = [
    {
      label: "Node",
      value: pod?.nodeName ? (
        <ResourceRef
          kind={ResourceType.Node}
          name={pod.nodeName}
          showKind={false}
        />
      ) : (
        "unscheduled"
      ),
      tone: pod?.nodeName ? undefined : "warn",
    },
    {
      label: "Pod IP",
      value: <CopyableAddress value={pod?.podIp} label="Pod IP" />,
    },
    {
      label: "Host IP",
      value: <CopyableAddress value={pod?.hostIp} label="Host IP" />,
    },
    {
      label: "Restarts",
      value: pod?.restartCount ?? 0,
      mono: true,
      tone: (pod?.restartCount ?? 0) > 0 ? "warn" : undefined,
    },
    {
      label: "Containers",
      value: pod
        ? `${pod.containers.filter((c) => c.ready).length} of ${pod.containers.length} ready`
        : "—",
      tone:
        pod && pod.containers.some((c) => !c.ready)
          ? ("warn" as const)
          : undefined,
    },
    ...(pod?.status.reason || pod?.status.message
      ? [
          {
            label: "Reason",
            value: pod.status.message || pod.status.reason || "",
            tone: "err" as const,
          },
        ]
      : []),
  ];

  return (
    <ResourceDetailLayout
      resource={pod}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Pod}
      title={pod?.name || name || "Pod"}
      namespace={pod?.namespace || namespace}
      createdAt={pod?.createdAt}
      onBack={() => navigate(-1)}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      statusBadge={
        pod?.status.phase ? <StatusBadge status={pod.status.phase} /> : null
      }
      onFindReplacement={handleFindReplacement}
      isSearchingReplacement={isSearchingReplacement}
      actions={
        <>
          <DetailAction
            label="Debug"
            icon={Bug}
            onClick={() => setDebugDialogOpen(true)}
            disabled={!currentContext || !pod}
          />
          <DetailAction
            label="Port forward"
            icon={Network}
            onClick={openPortForwardDialog}
            disabled={!currentContext || !pod}
          />
          <DetailAction
            label="Restart"
            icon={RefreshCw}
            onClick={() => restartMutation.mutate()}
            disabled={!pod}
            busy={restartMutation.isPending}
          />
          <DetailAction
            label="Delete"
            icon={Trash2}
            onClick={() => deleteMutation?.mutate()}
            disabled={!pod}
            busy={deleteMutation?.isPending}
            danger
          />
        </>
      }
      tabs={[
        {
          id: "overview",
          label: "Overview",
          content: (
            <>
              <KeyValueSection
                title="Labels"
                count={Object.keys(pod?.labels ?? {}).length}
                items={recordToKeyValues(pod?.labels ?? {})}
                emptyMessage="No labels"
              />
              <KeyValueSection
                title="Annotations"
                count={Object.keys(pod?.annotations ?? {}).length}
                items={recordToKeyValues(pod?.annotations ?? {})}
                emptyMessage="No annotations"
              />
            </>
          ),
        },
        {
          id: "containers",
          label: "Containers",
          content: pod ? (
            <ContainerRows
              containers={pod.containers}
              namespace={pod.namespace}
              podName={pod.name}
              onOpenShell={openTerminal}
            />
          ) : null,
        },
        {
          id: "logs",
          label: "Logs",
          content: pod ? (
            <div className="h-[70vh] min-h-[400px]">
              <LogViewer
                podName={pod.name}
                namespace={pod.namespace}
                containers={pod.containers.map((c) => c.name)}
              />
            </div>
          ) : null,
        },
        {
          id: "conditions",
          label: "Conditions",
          content: (
            <Section>
              <SectionHeader
                title="Conditions"
                count={pod?.status.conditions.length}
              />
              <ConditionRows conditions={pod?.status.conditions ?? []} />
            </Section>
          ),
        },
        {
          id: "yaml",
          label: "YAML",
          content: (
            <YamlTabContent
              yaml={yaml}
              onCopy={copyYaml}
              title={pod?.name || "Pod YAML"}
              resourceKind={ResourceType.Pod}
              resourceName={pod?.name || name || ""}
              namespace={pod?.namespace || namespace}
            />
          ),
        },
      ]}
    >
      {podStatus?.status !== "available" && (
        <MetricsStatusBanner status={podStatus} />
      )}

      <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
        <KeyValueSection title="Placement" items={placement} />
        <Section>
          <SectionHeader
            title="Usage"
            count="live usage against this pod's limits"
          />
          <div>
            <UsageRow
              label="CPU"
              used={podWithMetrics?.cpuMillicores}
              total={pod?.cpuLimits ? parseCPU(pod.cpuLimits) : null}
              type="cpu"
            />
            <UsageRow
              label="Memory"
              used={podWithMetrics?.memoryBytes}
              total={pod?.memoryLimits ? parseMemory(pod.memoryLimits) : null}
              type="memory"
            />
          </div>
        </Section>
      </div>

      {pod && (
        <RelatedResources
          ownerReferences={pod.ownerReferences}
          namespace={pod.namespace}
        />
      )}

      {pod && (
        <PodPortForwardDialog
          open={portForwardOpen}
          onOpenChange={setPortForwardOpen}
          pod={pod}
          form={portForwardForm}
          setForm={setPortForwardForm}
          busy={portForwardBusy}
          onSubmit={handlePortForward}
          activePortForwards={activePortForwards}
          portForwardStatusBySession={portForwardStatusBySession}
          onStopSession={handleStopPortForward}
        />
      )}

      {pod && (
        <DebugPodDialog
          open={debugDialogOpen}
          onOpenChange={setDebugDialogOpen}
          podName={pod.name}
          namespace={pod.namespace}
          containers={pod.containers.map((c) => c.name)}
          kubernetesVersion={clusterInfo?.git_version}
          onDebugStart={handleDebugStart}
        />
      )}

      {showTerminal && selectedContainer && pod && (
        <Section>
          <SectionHeader title={`Shell · ${selectedContainer}`} />
          {/* The xterm viewport paints its own background, so the frame only
              has to hold the canvas colour until the terminal attaches. */}
          <div className="relative h-[500px] overflow-hidden rounded border border-hair bg-canvas">
            <PodTerminal
              podName={pod.name}
              namespace={pod.namespace}
              containerName={selectedContainer}
              onClose={handleTerminalClose}
            />
          </div>
        </Section>
      )}
    </ResourceDetailLayout>
  );
}
