import { useNavigate } from "react-router-dom";
import { Section } from "@/components/ui/section";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Bug, RefreshCw, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { commands } from "@/lib/commands";
import { useMetrics, useResourceDetail, useClusterInfo } from "@/hooks";
import { mergePodsWithMetrics } from "@/lib/metrics";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { useClusterStore } from "@/stores/clusterStore";
import { MetricsStatusBanner } from "@/components/metrics";
import type { PodInfo, DebugResult } from "@/generated/types";
import { DebugPodDialog } from "@/components/debug";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { LogViewer } from "@/components/logs/LogViewer";
import { PodTerminal } from "@/components/terminal/PodTerminal";
import { YamlTabContent } from "@/components/resources/YamlTabContent";
import { LabelsDisplay } from "@/components/resources/LabelsDisplay";
import { ConditionsDisplay } from "@/components/resources/ConditionsDisplay";
import { ContainerCard } from "@/components/resources/ContainerCard";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import { useToast } from "@/components/ui/use-toast";
import { normalizeTauriError } from "@/lib/error-utils";

import { PodPortForwardDialog } from "@/components/pod/PodPortForwardDialog";
import { usePodPortForward } from "@/components/pod/usePodPortForward";
import { usePodReplacementSearch } from "@/components/pod/usePodReplacementSearch";
import { PodInfoCards } from "@/components/pod/PodInfoCards";

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

  return (
    <ResourceDetailLayout
      resource={pod}
      isLoading={isLoading}
      error={error}
      resourceKind={ResourceType.Pod}
      title={pod?.name || name || "Pod"}
      namespace={pod?.namespace || namespace}
      onBack={() => navigate(-1)}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      badges={
        pod?.status.phase ? <StatusBadge status={pod.status.phase} /> : null
      }
      onFindReplacement={handleFindReplacement}
      isSearchingReplacement={isSearchingReplacement}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDebugDialogOpen(true)}
            disabled={!currentContext || !pod}
          >
            <Bug className="mr-2 h-4 w-4" />
            Debug
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={openPortForwardDialog}
            disabled={!currentContext || !pod}
          >
            Port Forward
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => restartMutation.mutate()}
            disabled={restartMutation.isPending || !pod}
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
            onClick={() => deleteMutation?.mutate()}
            disabled={deleteMutation?.isPending || !pod}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        </>
      }
      tabs={[
        {
          id: "overview",
          label: "Overview",
          content: (
            <div className="space-y-4">
              {pod && (
                <LabelsDisplay labels={pod.labels} className="col-span-full" />
              )}
            </div>
          ),
        },
        {
          id: "containers",
          label: "Containers",
          content: pod ? (
            <div className="space-y-4">
              {pod.containers.map((container) => (
                <ContainerCard
                  key={container.name}
                  container={container}
                  namespace={namespace}
                  podName={pod.name}
                  showShell={true}
                  onOpenShell={openTerminal}
                />
              ))}
            </div>
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
        {
          id: "conditions",
          label: "Conditions",
          content: (
            <ConditionsDisplay conditions={pod?.status.conditions || []} />
          ),
        },
      ]}
    >
      {podStatus?.status !== "available" && (
        <MetricsStatusBanner status={podStatus} />
      )}

      {pod && <PodInfoCards pod={pod} podWithMetrics={podWithMetrics} />}

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
        <Section className="my-4 overflow-hidden border-2 border-muted">
          <div className="p-0 h-[500px] overflow-hidden relative bg-black">
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
