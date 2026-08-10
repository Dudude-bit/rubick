import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlignLeft,
  ArrowRight,
  BadgeCheck,
  Bug,
  Info,
  Network,
  RefreshCw,
  SquareTerminal,
  Trash2,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { StatusBadge } from "@/components/ui/status-badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { MetricsStatusBanner } from "@/components/metrics";
import { DebugPodDialog } from "@/components/debug";
import { LogViewer } from "@/components/logs/LogViewer";
import { PodShell } from "@/components/terminal/PodShell";
import { yamlTab } from "@/components/resources/yaml-tab";
import { RelatedResources } from "@/components/resources/RelatedResources";
import { TrafficChain } from "@/components/resources/TrafficChain";
import { connectionsTab } from "@/components/resources/connections-tab";
import { ResourceDetailLayout } from "@/components/resources/ResourceDetailLayout";
import {
  conditionsMark,
  countMark,
  kindGlyph,
  liveMark,
  severityMark,
  viewGlyph,
} from "@/components/resources/detail-tab";
import { ContainerRows } from "@/components/resources/container-rows";
import {
  ConditionRows,
  DetailAction,
  ProblemSummary,
} from "@/components/resources/detail-blocks";
import { UsageBlock } from "@/components/resources/usage-block";
import { ImageRef } from "@/components/resources/ImageRef";
import { ResourceMessage } from "@/components/resources/ResourceMessage";
import { ResourceRef } from "@/components/resources/ResourceRef";
import { VolumeRows } from "@/components/resources/volume-rows";
import {
  KeyValueSection,
  type KeyValue,
} from "@/components/resources/detail-kv";
import { recordToKeyValues } from "@/components/resources/key-values";
import { PodPortForwardDialog } from "@/components/pod/PodPortForwardDialog";
import { usePodPortForward } from "@/components/pod/usePodPortForward";
import { usePodReplacementSearch } from "@/components/pod/usePodReplacementSearch";
import { useMetrics, useResourceDetail, useClusterInfo } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useNodePlacement } from "@/hooks/useNodePlacement";
import { SpotMark } from "@/components/resources/spot-mark";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { InterceptedAction } from "@/components/resources/delivery-intercept";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { normalizeTauriError } from "@/lib/error-utils";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { mergePodsWithMetrics } from "@/lib/metrics";
import { ResourceType, toPlural } from "@/lib/resource-registry";
import { failingCondition } from "@/lib/condition-health";
import {
  lifetimeContainers,
  podContainers,
  podReadiness,
} from "@/lib/container-sequence";
import { statusRole } from "@/lib/status-role";
import {
  describeRestarts,
  describeTermination,
  terminationWhen,
} from "@/lib/pod-status";
import { useClusterStore } from "@/stores/clusterStore";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import type { ContainerInfo, PodInfo, DebugResult } from "@/generated/types";

interface PodProblem {
  /** The kubelet's own word for it, for the header row. */
  reason: string;
  /** A sentence, not a node: the tab strip puts it in an accessible name. */
  headline: string;
  detail: ReactNode;
  tone: "err" | "warn";
  /** The tab that holds the rest of the story. */
  tab: "containers" | "conditions";
}

/** A container that has not started yet is not a container in trouble. */
const STARTING = new Set(["containercreating", "podinitializing", "creating"]);

const CANNOT_PULL =
  /^(ImagePull|ErrImagePull|InvalidImageName|RegistryUnavailable)/i;

function describeWaiting(
  container: ContainerInfo,
  reason: string
): Omit<PodProblem, "tab"> {
  if (CANNOT_PULL.test(reason)) {
    return {
      reason,
      headline: `${container.name} cannot pull its image`,
      detail: (
        <>
          <ImageRef image={container.image} inline /> — the kubelet is retrying,
          waiting longer after each attempt. The name, the tag or the pull
          credentials are what to check.
        </>
      ),
      tone: "err",
    };
  }
  if (reason.toLowerCase() === "crashloopbackoff") {
    const last = container.lastTerminated;
    return {
      reason,
      headline: `${container.name} starts and then exits, over and over`,
      detail: last
        ? `${container.restartCount} restarts so far; the last run ended ${describeTermination(last)}${
            terminationWhen(last) ? `, ${terminationWhen(last)}` : ""
          }. What it printed before it died is in Logs.`
        : `${container.restartCount} restarts so far. What it printed before it last died is in Logs.`,
      tone: "err",
    };
  }
  if (/^CreateContainer(Config)?Error$/i.test(reason)) {
    return {
      reason,
      headline: `${container.name} cannot be built from this spec`,
      detail:
        "A ConfigMap, Secret or volume the container names is missing, or has no such key.",
      tone: "err",
    };
  }
  return {
    reason,
    headline: `${container.name} is waiting to start`,
    detail: reason,
    tone: statusRole(reason) === "err" ? "err" : "warn",
  };
}

/**
 * What is wrong with this pod, in one sentence, or nothing.
 *
 * Containers first and conditions second, because a container reason is
 * the specific answer and `Ready=False · containers with unready status:
 * [app]` is the same fact with the answer taken out. The Ready family is
 * skipped for that reason: it can only ever restate the loop above it.
 */
function podProblem(pod: PodInfo | null | undefined): PodProblem | null {
  if (!pod || pod.status.phase === "Succeeded") return null;

  // Init containers included, and first: a pod in `Init:CrashLoopBackOff`
  // has app containers that all read `PodInitializing`, so scanning only
  // `.containers` found nothing wrong with the one pod whose trouble has
  // a name. `podContainers` puts the sequence in run order, so the first
  // thing found is the first thing that broke.
  for (const container of podContainers(pod)) {
    const state = container.state;
    if (
      state.type === "waiting" &&
      state.reason &&
      !STARTING.has(state.reason.toLowerCase())
    ) {
      return {
        ...describeWaiting(container, state.reason),
        tab: "containers",
      };
    }
    if (state.type === "terminated" && state.termination.exitCode !== 0) {
      const { termination } = state;
      return {
        reason: termination.reason ?? "Error",
        headline: `${container.name} exited with ${termination.exitCode}`,
        detail: `${describeTermination(termination)} — the last run of this container did not finish cleanly.`,
        tone: "err",
        tab: "containers",
      };
    }
  }

  const condition = failingCondition(pod.status.conditions, [
    "Ready",
    "ContainersReady",
  ]);
  if (condition) {
    return {
      reason: condition.reason ?? condition.type,
      headline:
        condition.type === "PodScheduled"
          ? "No node will take this pod"
          : `${condition.type} is ${condition.status}`,
      detail: (
        <ResourceMessage
          message={condition.message ?? condition.reason ?? ""}
          subject={{ kind: "Pod", name: pod.name, namespace: pod.namespace }}
        />
      ),
      tone: condition.reason === "Unschedulable" ? "err" : "warn",
      tab: "conditions",
    };
  }

  // Eviction and the other node-level verdicts land here, and nowhere else
  // in the object says them.
  if (pod.status.reason || pod.status.message) {
    return {
      reason: pod.status.reason ?? "Failed",
      headline: pod.status.reason ?? "This pod failed",
      detail: (
        <ResourceMessage
          message={pod.status.message ?? ""}
          subject={{ kind: "Pod", name: pod.name, namespace: pod.namespace }}
        />
      ),
      tone: "err",
      tab: "conditions",
    };
  }

  return null;
}

export function PodDetail() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { currentContext } = useClusterStore();
  const queryClient = useQueryClient();
  const { data: clusterInfo } = useClusterInfo();

  // `?shell=<container>` is how somewhere else — the peek panel, a link —
  // asks for a shell on this pod. A terminal is unusable in a drawer, so it
  // opens here, at full width, where the session behaves like any other.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedShell = searchParams.get("shell");

  // Which container the Shell tab is attached to, once the reader has said.
  // `container: null` is the reader having ended the session, which is not the
  // same as never having chosen: the tab attaches to whatever can take a shell
  // when nobody has said, and re-attaching to one somebody just closed would
  // be a loop rather than a tab.
  //
  // Carried with the pod it was chosen on, for the reason `logRequest` is: this
  // page stays mounted across a move to another pod, and `app` means a
  // different container there.
  const [shellChoice, setShellChoice] = useState<{
    pod: string;
    container: string | null;
  } | null>(null);
  const [debugDialogOpen, setDebugDialogOpen] = useState(false);
  // Which container the Logs tab was sent to read, from a row in the
  // Containers tab. The viewer decides where to open on its own when
  // nobody has asked, so this stays null for an ordinary visit.
  //
  // The pod it was asked for is stored with it: this page stays mounted
  // across a move to another pod, and a container name is not unique
  // between them — carrying `app` over would solo a container in a pod
  // nobody asked about.
  const [logRequest, setLogRequest] = useState<{
    pod: string;
    container: string;
  } | null>(null);

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
    // A link that asked for a shell asked to land on it, not to arrive at the
    // Overview with a terminal running somewhere off screen.
    defaultTab: requestedShell ? "shell" : undefined,
  });

  const connections = useConnections(ResourceType.Pod, name, namespace);
  const nodeIsSpot = useNodePlacement(pod?.nodeName)?.spot ?? false;

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

  const { podMetrics, podStatus, podSampledAt } = useMetrics({
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

  const podKey = `${namespace}/${name}`;
  const logContainer = logRequest?.pod === podKey ? logRequest.container : null;

  // The URL's `?shell=` is about this route, so it needs no pod key of its
  // own; a choice made by clicking does.
  const choice = shellChoice?.pod === podKey ? shellChoice : null;
  const shellContainer = choice ? choice.container : requestedShell;
  const shellEnded = choice !== null && choice.container === null;

  const openTerminal = (containerName: string) => {
    setShellChoice({ pod: podKey, container: containerName });
    setActiveTab("shell");
  };

  const openLogs = (containerName: string) => {
    setLogRequest({ pod: podKey, container: containerName });
    setActiveTab("logs");
  };

  const handleDebugStart = (result: DebugResult) => {
    if (result.isNewPod) {
      navigate(
        `/${toPlural(ResourceType.Pod)}/${result.namespace}/${result.podName}`,
        { replace: false }
      );
    } else {
      openTerminal(result.containerName);
    }
  };

  // Debug pods (created by copy/node debug) get a delete-now reminder
  // when the terminal closes — they keep running otherwise.
  const isDebugPod = pod?.labels?.["k8s-gui/debug-pod"] === "true";

  const handleTerminalClose = useCallback(() => {
    setShellChoice({ pod: podKey, container: null });
    // The URL asked for this shell; once it is closed it would be lying, and
    // a reload would reopen a terminal nobody asked for again.
    if (searchParams.has("shell")) {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("shell");
          return next;
        },
        { replace: true }
      );
    }

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
  }, [isDebugPod, pod, podKey, toast, navigate, searchParams, setSearchParams]);

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
        <span className="inline-flex items-baseline gap-2">
          <ResourceRef
            kind={ResourceType.Node}
            name={pod.nodeName}
            showKind={false}
          />
          {nodeIsSpot && <SpotMark says="spot" />}
        </span>
      ) : (
        "unscheduled"
      ),
      tone: pod?.nodeName ? undefined : "warn",
    },
    // Said in words as well as in the mark, because the mark alone would read
    // as a warning about this pod. "It will be evicted at some point and that
    // is fine" is a different fact from "it keeps dying", and the row that
    // carries it sits beside Restarts, which is the fact it is mistaken for.
    ...(nodeIsSpot
      ? [
          {
            label: "Spot node",
            value:
              "The cloud can reclaim this node at any time. An eviction here is the arrangement, not a fault.",
          },
        ]
      : []),
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
      value: pod ? describeRestarts(pod) : 0,
      tone: (pod?.restartCount ?? 0) > 0 ? "warn" : undefined,
    },
    // Where the raw phase stays reachable — "the pod really is in phase
    // Running while its container loops" is a thing an SRE has to be able
    // to check. Only when it disagrees with the header, which is the only
    // time the two are not the same word twice.
    ...(pod && pod.status.phase !== pod.status.display
      ? [{ label: "Phase", value: pod.status.phase, mono: true }]
      : []),
    {
      label: "Containers",
      value: pod
        ? `${podReadiness(pod).ready} of ${podReadiness(pod).total} ready`
        : "—",
      tone: pod && !podReadiness(pod).allReady ? ("warn" as const) : undefined,
    },
    {
      // The identity every request this pod makes is authorised as. The
      // reference has nowhere to go — `isRoutableKind` rejects ServiceAccount,
      // so it renders as the glyph and the tinted name and no link — but it
      // is the same object under the same mark wherever it is named, and the
      // day the kind gets a page it lights up without a change here.
      label: "Service account",
      value: pod?.serviceAccountName ? (
        <ResourceRef
          kind="ServiceAccount"
          name={pod.serviceAccountName}
          namespace={pod.namespace}
          showKind={false}
        />
      ) : (
        // The API server fills this in; a pod that states nothing still runs
        // as something, and saying "none" would be wrong.
        "default"
      ),
    },
  ];

  const problem = useMemo(() => podProblem(pod), [pod]);

  // A shell the reader opened and left is invisible the moment they click
  // Logs. The store already knows it is there; the dot is how the tab says so.
  const shellSession = useTerminalSessionStore((state) =>
    state.sessions.find(
      (session) => session.podName === name && session.namespace === namespace
    )
  );

  const deliveryQuery = deliveryOfKind(ResourceType.Pod, pod);
  const intercept = useDeliveryIntercept(deliveryQuery);

  return (
    <ResourceDetailLayout
      resource={pod}
      delivery={deliveryQuery}
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
        pod?.status.display ? (
          <StatusBadge
            status={pod.status.display}
            title={`Phase ${pod.status.phase}`}
          />
        ) : null
      }
      // The kubelet's word for the trouble, on every tab — but only when
      // the badge is not already saying it. Now the badge carries the
      // derived status, `CrashLoopBackOff CrashLoopBackOff` is what the
      // unconditional version renders.
      badges={
        problem &&
        // `endsWith` rather than equality: a pod held in init displays
        // `Init:CrashLoopBackOff`, and the init container's own reason is
        // the tail of it — printing both is the same word twice with a
        // prefix.
        !pod?.status.display?.endsWith(problem.reason) && (
          <span
            className={`text-[11px] ${problem.tone === "err" ? "text-err" : "text-warn"}`}
          >
            {problem.reason}
          </span>
        )
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
          <InterceptedAction
            intercept={intercept("Restart")}
            label="Restart"
            icon={RefreshCw}
            onClick={() => restartMutation.mutate()}
            disabled={!pod}
            busy={restartMutation.isPending}
          />
          <InterceptedAction
            intercept={intercept("Delete")}
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
          glyph: viewGlyph(Info),
          content: (
            <>
              {pod && (
                <VolumeRows
                  volumes={pod.volumes}
                  namespace={pod.namespace}
                  containerCount={
                    pod.containers.length + pod.initContainers.length
                  }
                />
              )}
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
        connectionsTab(connections, deliveryQuery),
        {
          id: "containers",
          label: "Containers",
          // A container has no kind of its own; it is what a Pod is made of,
          // so it arrives under the Pod's cube and the Pod's hue — the same
          // mark the reader clicked to get here.
          glyph: kindGlyph(ResourceType.Pod),
          // The dot displaces the count rather than joining it: a pod with a
          // dead container is not asking how many it has.
          mark:
            problem?.tab === "containers"
              ? severityMark(problem.tone, problem.headline)
              : countMark(pod ? podContainers(pod).length : 0),
          content: pod ? (
            <ContainerRows
              pod={pod}
              namespace={pod.namespace}
              podName={pod.name}
              onOpenShell={openTerminal}
              onOpenLogs={openLogs}
            />
          ) : null,
        },
        {
          id: "logs",
          label: "Logs",
          glyph: viewGlyph(AlignLeft),
          kind: "surface",
          content: pod ? (
            <LogViewer
              key={`logs:${logContainer ?? ""}`}
              podName={pod.name}
              namespace={pod.namespace}
              containers={podContainers(pod)}
              soloContainer={logContainer}
            />
          ) : null,
        },
        {
          id: "shell",
          label: "Shell",
          glyph: viewGlyph(SquareTerminal),
          kind: "surface",
          mark: shellSession
            ? liveMark(`session attached to ${shellSession.containerName}`)
            : undefined,
          content: pod ? (
            <PodShell
              pod={pod}
              container={shellContainer}
              ended={shellEnded}
              onChoose={openTerminal}
              onOpenLogs={openLogs}
              onDebug={() => setDebugDialogOpen(true)}
              onEnd={handleTerminalClose}
            />
          ) : null,
        },
        {
          id: "conditions",
          label: "Conditions",
          glyph: viewGlyph(BadgeCheck),
          mark: conditionsMark(pod?.status.conditions),
          content: (
            <Section>
              <SectionHeader
                title="Conditions"
                count={pod?.status.conditions.length}
              />
              <ConditionRows
                conditions={pod?.status.conditions ?? []}
                subject={{ kind: ResourceType.Pod, name, namespace }}
              />
            </Section>
          ),
        },
        yamlTab({
          yaml,
          onCopy: copyYaml,
          title: pod?.name || "Pod YAML",
          resourceKind: ResourceType.Pod,
          resourceName: pod?.name || name || "",
          namespace: pod?.namespace || namespace,
        }),
      ]}
    >
      {problem && (
        <ProblemSummary
          headline={problem.headline}
          detail={problem.detail}
          tone={problem.tone}
          action={
            <DetailAction
              label={`See ${problem.tab}`}
              icon={ArrowRight}
              onClick={() => setActiveTab(problem.tab)}
            />
          }
        />
      )}

      {podStatus?.status !== "available" && (
        <MetricsStatusBanner status={podStatus} />
      )}

      <div className="grid gap-x-8 gap-y-[22px] md:grid-cols-2">
        <KeyValueSection title="Placement" items={placement} />
        <UsageBlock
          kind={ResourceType.Pod}
          uid={pod?.uid}
          cpu={podWithMetrics?.cpuMillicores}
          memory={podWithMetrics?.memoryBytes}
          cpuLimit={pod?.cpuLimits ? parseCPU(pod.cpuLimits) : null}
          memoryLimit={pod?.memoryLimits ? parseMemory(pod.memoryLimits) : null}
          restarts={pod?.restartCount ?? null}
          sampledAt={podSampledAt}
          status={podStatus}
          connections={connections.data}
          history={
            pod?.namespace && pod?.name
              ? { kind: "pod", namespace: pod.namespace, pod: pod.name }
              : undefined
          }
        />
      </div>

      <TrafficChain query={connections} />

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
          containers={lifetimeContainers(pod).map((c) => c.name)}
          kubernetesVersion={clusterInfo?.git_version}
          onDebugStart={handleDebugStart}
        />
      )}
    </ResourceDetailLayout>
  );
}
