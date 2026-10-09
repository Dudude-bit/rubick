import { useCallback, useMemo, useState, type ReactNode } from "react";
import { DeleteAction } from "../../../-object/DeleteAction";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlignLeft,
  ArrowRight,
  BadgeCheck,
  Bug,
  FolderOpen,
  Stethoscope,
  Info,
  Network,
  Shield,
  SquareTerminal,
} from "lucide-react";

import { Section, SectionHeader } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { CopyableAddress } from "@/components/ui/copyable-value";
import { MetricsStatusBanner } from "../../../-metrics";
import { DebugPodDialog } from "../../../-debug";
import { FilesTab } from "./FilesTab";
import { ChecksTab } from "./ChecksTab";
import type { Via } from "@/generated/types";
import { LogViewer } from "../../../-logs/LogViewer";
import { PodShell } from "./PodShell";
import { yamlTab } from "../../../-object/yaml-tab";
import { RelatedResources } from "../../-components/RelatedResources";
import { serviceAccountRow } from "../../-components/identity-rows";
import { TrafficChain } from "../../../-object/TrafficChain";
import { connectionsTab } from "../../../-object/connections-tab";
import { ResourceDetailLayout } from "../../../-object/ResourceDetailLayout";
import {
  conditionsMark,
  countMark,
  kindGlyph,
  liveMark,
  severityMark,
  viewGlyph,
} from "@/components/object/detail-tab";
import { ContainerRows } from "../../../-object/container-rows";
import {
  FactBlock,
  WorkloadOverview,
} from "../../-components/workload-overview";
import { AlertsAbout } from "../../../-object/AlertsAbout";
import {
  ConditionRows,
  DetailAction,
  ProblemSummary,
  ReasonedAction,
} from "@/components/object/detail-blocks";
import { usePodDenied } from "@/lib/access";
import { UsageBlock } from "../../../-usage/usage-block";
import { ImageRef } from "@/components/object/ImageRef";
import { ResourceMessage } from "@/components/object/ResourceMessage";
import { ResourceRef } from "@/components/object/ResourceRef";
import { MostLikelyPanel } from "./MostLikelyPanel";
import { PodStatusBadge } from "./PodStatusBadge";
import { usePodShare } from "./usePodShare";
import { VolumeRows } from "./volume-rows";
import { KeyValueSection, type KeyValue } from "../../../-object/detail-kv";
import { recordToKeyValues } from "@/components/object/key-values";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { podForwardPorts } from "@/lib/port-forward";
import { PodNetworkPolicies } from "./PodNetworkPolicies";
import { usePodReplacementSearch } from "./usePodReplacementSearch";
import { useMetrics, useResourceDetail, useClusterInfo } from "@/hooks";
import { isResourceNotFoundError } from "@/hooks/useResourceDetail";
import { useSilentNodes } from "@/hooks/useSilentNodes";
import { usePodWatch } from "@/hooks/usePodWatch";
import { silenceOf } from "@/lib/node-reporting";
import { useConnections } from "@/hooks/useConnections";
import { useObjectEvents } from "@/hooks/useObjectEvents";
import { eventsTab } from "../../../-object/events-tab";
import { useNodePlacement } from "./useNodePlacement";
import { SpotMark } from "../../../-object/spot-mark";
import { commands } from "@/lib/commands";
import { deliveryOfKind } from "@/lib/delivery";
import { useDeliveryIntercept } from "../../../-delivery/useDelivery";
import { normalizeTauriError } from "@/lib/error-utils";
import { queryKeys } from "@/lib/query-keys";
import { parseCPU, parseMemory } from "@/lib/k8s-quantity";
import { mergePodsWithMetrics } from "@/lib/metrics";
import { ResourceType } from "@/lib/resource-registry";
import { objectLink } from "@/lib/links";
import { useAppSearch, useSetSearch } from "@/hooks/useSearchParam";
import { failingCondition } from "@/lib/condition-health";
import {
  lifetimeContainers,
  podContainers,
  podReadiness,
} from "@/lib/container-sequence";
import { statusRole } from "@/lib/status-role";
import {
  loopingContainer,
  loopState,
  seenLoop,
  withKnownLoop,
  type SeenLoop,
} from "@/lib/crash-loop";
import {
  describeRestarts,
  describeTermination,
  lastTermination,
  terminationWhen,
} from "@/lib/pod-status";
import { useClusterStore } from "@/stores/clusterStore";
import { useTerminalSessionStore } from "@/stores/terminalSessionStore";
import type {
  ContainerInfo,
  DebugResult,
  EventInfo,
  PodInfo,
} from "@/generated/types";
import { useT } from "@/i18n/useT";
import { toastError } from "@/lib/toast-error";
import { errorToShow } from "@/lib/error-utils";
import { TONE_TEXT } from "@/lib/tone";

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
  reason: string,
  t: ReturnType<typeof useT>
): Omit<PodProblem, "tab"> {
  if (CANNOT_PULL.test(reason)) {
    return {
      reason,
      headline: t("empty", "cannotPullImage", { container: container.name }),
      detail: (
        <>
          <ImageRef image={container.image} inline />{" "}
          {t("empty", "imagePullRetrying")}
        </>
      ),
      tone: "err",
    };
  }
  if (reason.toLowerCase() === "crashloopbackoff") {
    return crashLoop(container, reason, t);
  }
  if (/^CreateContainer(Config)?Error$/i.test(reason)) {
    return {
      reason,
      headline: t("empty", "cannotBeBuilt", { container: container.name }),
      detail: t("empty", "missingConfigMapSecretOrVolume"),
      tone: "err",
    };
  }
  return {
    reason,
    headline: t("empty", "waitingToStart", { container: container.name }),
    detail: reason,
    tone: statusRole(reason) === "err" ? "err" : "warn",
  };
}

/**
 * The pod as read, its loop carried across a read the kubelet sent without
 * the last exit, from what this page saw before it and from the pod's events.
 */
function useKnownLoop(
  read: PodInfo | undefined,
  events: readonly EventInfo[] | undefined
): PodInfo | undefined {
  const [seen, setSeen] = useState<SeenLoop | null>(null);
  const pod = useMemo(
    () => read && withKnownLoop(read, seen, events ?? []),
    [read, seen, events]
  );
  const next = pod ? seenLoop(pod, seen) : seen;
  if (next !== seen) setSeen(next);
  return pod;
}

/** The same loop whichever instant of the back-off the read caught. */
function crashLoop(
  container: ContainerInfo,
  reason: string,
  t: ReturnType<typeof useT>
): Omit<PodProblem, "tab"> {
  const last = lastTermination(container);
  return {
    reason,
    headline: t("empty", "startsAndExits", { container: container.name }),
    detail: last
      ? t("empty", "crashRestartsWithLastRun", {
          n: container.restartCount,
          how: `${describeTermination(last)}${
            terminationWhen(last, t) ? `, ${terminationWhen(last, t)}` : ""
          }`,
        })
      : t("empty", "crashRestartsNoLastRun", { n: container.restartCount }),
    tone: "err",
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
function podProblem(
  pod: PodInfo | null | undefined,
  t: ReturnType<typeof useT>
): PodProblem | null {
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
        ...describeWaiting(container, state.reason, t),
        tab: "containers",
      };
    }
    if (state.type === "terminated" && state.termination.exitCode !== 0) {
      const { termination } = state;
      return {
        reason: termination.reason ?? "Error",
        headline: t("empty", "containerExitedWith", {
          container: container.name,
          code: termination.exitCode,
        }),
        detail: t("empty", "lastRunNotClean", {
          how: describeTermination(termination),
        }),
        tone: "err",
        tab: "containers",
      };
    }
  }

  const loop = loopState(pod.status);
  const looping =
    loop === "looping" ? loopingContainer(podContainers(pod)) : null;
  if (looping) {
    return {
      ...crashLoop(looping, pod.status.display, t),
      tab: "containers",
    };
  }
  const unreported =
    loop === "unreported"
      ? podContainers(pod).find(
          (c) => c.restartCount > 0 && !lastTermination(c)
        )
      : undefined;
  if (unreported) {
    return {
      reason: pod.status.display,
      headline: t("empty", "restartedExitUnreported", {
        container: unreported.name,
      }),
      detail: t("empty", "restartsExitUnreportedDetail", {
        n: unreported.restartCount,
      }),
      tone: "warn",
      tab: "containers",
    };
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
          ? t("empty", "noNodeWillTakePod")
          : t("empty", "conditionIsStatus", {
              type: condition.type,
              status: condition.status,
            }),
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
      headline: pod.status.reason ?? t("empty", "thisPodFailed"),
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
  const t = useT();
  const navigate = useNavigate();
  const router = useRouter();
  const { toast } = useToast();
  const { currentContext } = useClusterStore();
  const queryClient = useQueryClient();
  const { data: clusterInfo } = useClusterInfo();

  // `?shell=<container>` is how somewhere else — the peek panel, a link —
  // asks for a shell on this pod. A terminal is unusable in a drawer, so it
  // opens here, at full width, where the session behaves like any other.
  const requestedShell = useAppSearch().shell ?? null;
  const setSearch = useSetSearch();

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
  // Which tab asked for the debug container: the shell opens a terminal in
  // it, the files tab reads through it.
  const [debugFor, setDebugFor] = useState<"shell" | "files">("shell");
  // Which container the Files tab wants read. The debug container's
  // /proc/1/root is whatever it targets, so defaulting the dialog to
  // containers[0] could read one container and label it another.
  const [debugTarget, setDebugTarget] = useState<string | null>(null);
  const [filesVia, setFilesVia] = useState<Via | null>(null);
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
    resource: read,
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
    freshness,
  } = useResourceDetail<PodInfo>({
    resourceKind: ResourceType.Pod,
    fetchResource: (name, namespace) => commands.getPod(name, namespace),
    deleteResource: (name, namespace) =>
      commands.deletePod(name, namespace, null),
    // A link that asked for a shell asked to land on it, not to arrive at the
    // Overview with a terminal running somewhere off screen.
    defaultTab: requestedShell ? "shell" : undefined,
  });

  // A gone pod is the page's whole answer; nothing else about it is asked.
  const gone = isResourceNotFoundError(error);
  usePodWatch(namespace, name, !gone);
  const connections = useConnections(ResourceType.Pod, name, namespace, !gone);
  // The pod's own events, for the "most likely" sentence: read here rather
  // than inside the panel so a refusal reaches it as a line, not a crash.
  const podEvents = useObjectEvents("Pod", name, namespace, {
    enabled: !gone,
    refresh: "slow",
  });
  const pod = useKnownLoop(read, podEvents.data);

  const share = usePodShare(pod, podEvents.data ?? [], podEvents.error);
  const nodeIsSpot = useNodePlacement(pod?.nodeName)?.spot ?? false;
  // The kubelet on this pod's node writes its status. If the node stopped
  // answering, everything below is the last thing it said, not the state now.
  const silence = silenceOf(pod?.nodeName, useSilentNodes(Boolean(pod)));

  const {
    savedLabels,
    isSearching: isSearchingReplacement,
    findReplacement,
  } = usePodReplacementSearch(pod, name, namespace);

  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const denied = usePodDenied(pod?.namespace || namespace || null);

  const { podMetrics, podStatus, podSampledAt } = useMetrics({
    namespace: namespace || null,
    includeNodes: false,
    enabled: !!pod && !gone,
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
        title: t("action", "podRestarted"),
        description: t("action", "podRestartingDetail", { name: name ?? "" }),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.detail(ResourceType.Pod, namespace, name),
      });
      refetch();
    },
    onError: (err) => {
      toast({
        title: t("action", "error"),
        description: t("action", "failedToRestartPod", {
          error: errorToShow(err),
        }),
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
        objectLink({
          kind: ResourceType.Pod,
          name: result.podName,
          namespace: result.namespace,
        })!
      );
    } else if (debugFor === "files") {
      setFilesVia({ container: result.containerName, root: "/proc/1/root" });
      setActiveTab("files");
    } else {
      openTerminal(result.containerName);
    }
  };

  // Debug pods (created by copy/node debug) get a delete-now reminder
  // when the terminal closes — they keep running otherwise.
  // Both labels: the debug toolbox and the Checks tab's copy are both pods
  // this app made and both worth offering to remove when the reader is done.
  const isDebugPod =
    pod?.labels?.["k8s-gui/debug-pod"] === "true" ||
    pod?.labels?.["k8s-gui/check-pod"] === "true";

  const handleTerminalClose = useCallback(() => {
    setShellChoice({ pod: podKey, container: null });
    // The URL asked for this shell; once it is closed it would be lying, and
    // a reload would reopen a terminal nobody asked for again.
    if (requestedShell) setSearch({ shell: undefined }, { replace: true });

    if (isDebugPod && pod) {
      toast({
        title: t("action", "debugPodStillRunning"),
        description: t("action", "debugPodDeleteHint"),
        action: (
          <Button
            size="sm"
            variant="destructive"
            onClick={async () => {
              try {
                await commands.deleteDebugPod(pod.name, pod.namespace);
                toast({
                  title: t("action", "debugPodDeleted"),
                  description: pod.name,
                });
                router.history.back();
              } catch (err) {
                toastError(t("action", "failedToDelete"), err);
              }
            }}
          >
            {t("action", "deleteNow")}
          </Button>
        ),
        duration: 10000,
      });
    }
  }, [isDebugPod, pod, podKey, t, toast, router, requestedShell, setSearch]);

  const handleFindReplacement = savedLabels
    ? () =>
        findReplacement().then((replacement) => {
          if (replacement) {
            toast({
              title: t("action", "foundReplacementPod"),
              description: t("action", "switchingTo", {
                name: replacement.name,
              }),
            });
            navigate({
              ...objectLink({
                kind: ResourceType.Pod,
                name: replacement.name,
                namespace: replacement.namespace,
              })!,
              replace: true,
            });
          } else {
            toast({
              title: t("action", "noReplacementFound"),
              description: t("empty", "noMatchingRunningPods"),
              variant: "destructive",
            });
          }
        })
    : undefined;

  const placement: KeyValue[] = [
    {
      label: t("columns", "node"),
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
        t("empty", "unscheduled")
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
            label: t("columns", "spotNode"),
            value: t("empty", "spotNodeNote"),
          },
        ]
      : []),
    {
      label: t("columns", "podIp"),
      value: (
        <CopyableAddress value={pod?.podIp} label={t("columns", "podIp")} />
      ),
    },
    {
      label: t("columns", "hostIp"),
      value: (
        <CopyableAddress value={pod?.hostIp} label={t("columns", "hostIp")} />
      ),
    },
    {
      label: t("columns", "restarts"),
      value: pod ? describeRestarts(pod, t) : 0,
      tone: (pod?.restartCount ?? 0) > 0 ? "warn" : undefined,
    },
    // Where the raw phase stays reachable — "the pod really is in phase
    // Running while its container loops" is a thing an SRE has to be able
    // to check. Only when it disagrees with the header, which is the only
    // time the two are not the same word twice.
    ...(pod && pod.status.phase !== pod.status.display
      ? [{ label: t("columns", "phase"), value: pod.status.phase, mono: true }]
      : []),
    {
      label: t("columns", "containers"),
      value: pod
        ? t("count", "ofTotalReady", {
            n: podReadiness(pod).ready,
            total: podReadiness(pod).total,
          })
        : t("empty", "unknownLower"),
      tone: pod && !podReadiness(pod).allReady ? ("warn" as const) : undefined,
    },
    serviceAccountRow(pod?.serviceAccountName, pod?.namespace, t),
  ];

  const problem = useMemo(() => podProblem(pod, t), [pod, t]);

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
    <>
      <ResourceDetailLayout
        freshness={freshness}
        resource={pod}
        share={share}
        delivery={deliveryQuery}
        isLoading={isLoading}
        error={error}
        resourceKind={ResourceType.Pod}
        title={pod?.name || name || "Pod"}
        namespace={pod?.namespace || namespace}
        createdAt={pod?.createdAt}
        onBack={() => router.history.back()}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        statusBadge={
          pod?.status.display ? (
            <PodStatusBadge pod={pod} silence={silence} />
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
            <span className={`text-[11px] ${TONE_TEXT[problem.tone]}`}>
              {problem.reason}
            </span>
          )
        }
        onFindReplacement={handleFindReplacement}
        isSearchingReplacement={isSearchingReplacement}
        goneNote={
          (activeTab === "shell" || shellSession) && (
            <p className="flex items-center gap-1.5 text-xs text-warn">
              <SquareTerminal className="h-3.5 w-3.5 flex-none" aria-hidden />
              {t("empty", "shellEndedPodGone")}
            </p>
          )
        }
        summary={
          problem && (
            <ProblemSummary
              headline={problem.headline}
              detail={problem.detail}
              tone={problem.tone}
              action={
                <DetailAction
                  label={t(
                    "action",
                    problem.tab === "containers"
                      ? "seeContainers"
                      : "seeConditions"
                  )}
                  icon={ArrowRight}
                  onClick={() => setActiveTab(problem.tab)}
                />
              }
            />
          )
        }
        actions={
          <>
            <ReasonedAction
              label={t("action", "debug")}
              icon={Bug}
              onClick={() => setDebugDialogOpen(true)}
              disabled={!currentContext || !pod}
              reason={denied.debug}
            />
            <ReasonedAction
              label={t("action", "portForward")}
              icon={Network}
              onClick={() => setPortForwardOpen(true)}
              disabled={!currentContext || !pod}
              reason={denied.portForward}
            />
            <DeleteAction
              restart
              kind={ResourceType.Pod}
              name={pod?.name || name || "Pod"}
              namespace={pod?.namespace || namespace}
              detail={pod}
              intercept={intercept("Restart")}
              mutation={restartMutation}
              disabled={!pod}
            />
            <DeleteAction
              kind={ResourceType.Pod}
              name={pod?.name || name || "Pod"}
              namespace={pod?.namespace || namespace}
              detail={pod}
              intercept={intercept("Delete")}
              mutation={deleteMutation}
              disabled={!pod}
            />
          </>
        }
        tabs={[
          {
            id: "overview",
            label: t("nav", "overview"),
            glyph: viewGlyph(Info),
            content: (
              <>
                {podStatus?.status !== "available" && (
                  <MetricsStatusBanner status={podStatus} />
                )}
                {pod && (
                  <MostLikelyPanel
                    pod={pod}
                    events={podEvents.data ?? []}
                    eventsError={
                      podEvents.error ? errorToShow(podEvents.error) : null
                    }
                    // The log tab opened on the current run with no
                    // container selected, so the row that says "read the
                    // last lines of X before the exit" landed on whatever
                    // the pane happened to be showing.
                    onOpenTab={(tab, container) =>
                      tab === "logs" && container
                        ? openLogs(container)
                        : setActiveTab(tab)
                    }
                  />
                )}

                {/* A Pod is the only member of the family with no count block: it
                  does not have a replica count, it *is* one, and the page that
                  answers "who sets the number" for it is the owner at the top
                  of its chain — which `RelatedResources` names below, with the
                  clause saying which of the two hops the count lives on. What
                  takes the first slot is the question a Pod does have in the
                  same place: where the one is. */}
                <WorkloadOverview
                  alerts={
                    <AlertsAbout
                      kind={ResourceType.Pod}
                      name={name ?? ""}
                      namespace={namespace ?? null}
                    />
                  }
                  count={
                    <FactBlock
                      title={t("columns", "placement")}
                      items={placement}
                    />
                  }
                  usage={
                    <UsageBlock
                      kind={ResourceType.Pod}
                      uid={pod?.uid}
                      cpu={podWithMetrics?.cpuMillicores}
                      memory={podWithMetrics?.memoryBytes}
                      cpuLimit={pod?.cpuLimits ? parseCPU(pod.cpuLimits) : null}
                      cpuRequest={
                        pod?.cpuRequests ? parseCPU(pod.cpuRequests) : null
                      }
                      memoryRequest={
                        pod?.memoryRequests
                          ? parseMemory(pod.memoryRequests)
                          : null
                      }
                      memoryLimit={
                        pod?.memoryLimits ? parseMemory(pod.memoryLimits) : null
                      }
                      restarts={pod?.restartCount ?? null}
                      sampledAt={podSampledAt}
                      status={podStatus}
                      connections={connections.data}
                      history={
                        pod?.namespace && pod?.name
                          ? {
                              kind: "pod",
                              namespace: pod.namespace,
                              pod: pod.name,
                            }
                          : undefined
                      }
                    />
                  }
                  traffic={<TrafficChain query={connections} />}
                >
                  {pod && (
                    <RelatedResources
                      ownerReferences={pod.ownerReferences}
                      namespace={pod.namespace}
                    />
                  )}
                </WorkloadOverview>

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
                  title={t("columns", "labels")}
                  count={Object.keys(pod?.labels ?? {}).length}
                  items={recordToKeyValues(pod?.labels ?? {})}
                  emptyMessage={t("empty", "noLabels")}
                />
                <KeyValueSection
                  title={t("columns", "annotations")}
                  count={Object.keys(pod?.annotations ?? {}).length}
                  items={recordToKeyValues(pod?.annotations ?? {})}
                  emptyMessage={t("empty", "noAnnotations")}
                />
              </>
            ),
          },
          connectionsTab(connections, t, deliveryQuery),
          {
            id: "network-policies",
            // The kind's own name, which is never translated.
            label: "NetworkPolicies",
            glyph: viewGlyph(Shield),
            content: pod ? <PodNetworkPolicies pod={pod} /> : null,
          },
          {
            id: "containers",
            label: t("columns", "containers"),
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
                shellDenied={denied.shell}
                onOpenLogs={openLogs}
              />
            ) : null,
          },
          {
            id: "logs",
            label: t("action", "logs"),
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
            label: t("columns", "shell"),
            glyph: viewGlyph(SquareTerminal),
            kind: "surface",
            mark: shellSession
              ? liveMark(
                  t("empty", "sessionAttachedTo", {
                    container: shellSession.containerName,
                  })
                )
              : undefined,
            content: pod ? (
              <PodShell
                pod={pod}
                container={shellContainer}
                ended={shellEnded}
                onChoose={openTerminal}
                onOpenLogs={openLogs}
                onDebug={() => {
                  setDebugFor("shell");
                  setDebugDialogOpen(true);
                }}
                denied={denied}
                onEnd={handleTerminalClose}
              />
            ) : null,
          },
          {
            id: "files",
            label: t("columns", "files"),
            glyph: viewGlyph(FolderOpen),
            kind: "surface",
            content: pod ? (
              <FilesTab
                key={`files:${pod.uid}`}
                pod={pod}
                via={filesVia}
                onDebug={(target) => {
                  setDebugFor("files");
                  setDebugTarget(target);
                  setDebugDialogOpen(true);
                }}
                debugDenied={denied.ephemeral}
                onStopVia={() => setFilesVia(null)}
              />
            ) : null,
          },
          {
            id: "checks",
            label: t("checks", "tab"),
            glyph: viewGlyph(Stethoscope),
            content: pod ? (
              <ChecksTab key={`checks:${pod.uid}`} pod={pod} />
            ) : null,
          },
          {
            id: "conditions",
            label: t("columns", "conditions"),
            glyph: viewGlyph(BadgeCheck),
            mark: conditionsMark(pod?.status.conditions, t),
            content: (
              <Section>
                <SectionHeader
                  title={t("columns", "conditions")}
                  count={pod?.status.conditions.length}
                />
                <ConditionRows
                  conditions={pod?.status.conditions ?? []}
                  subject={{ kind: ResourceType.Pod, name, namespace }}
                />
              </Section>
            ),
          },
          eventsTab(podEvents, t, { kind: ResourceType.Pod, name: name ?? "" }),
          yamlTab({
            yaml,
            onCopy: copyYaml,
            title: pod?.name || "Pod YAML",
            resourceKind: ResourceType.Pod,
            resourceName: pod?.name || name || "",
            namespace: pod?.namespace || namespace,
          }),
        ]}
      />

      {pod && (
        <PortForwardDialog
          open={portForwardOpen}
          onOpenChange={setPortForwardOpen}
          target={{
            kind: "Pod",
            name: pod.name,
            namespace: pod.namespace,
            ports: podForwardPorts(pod),
          }}
        />
      )}

      {pod && (
        <DebugPodDialog
          open={debugDialogOpen}
          onOpenChange={setDebugDialogOpen}
          podName={pod.name}
          namespace={pod.namespace}
          containers={lifetimeContainers(pod).map((c) => c.name)}
          preferredTarget={debugTarget ?? undefined}
          kubernetesVersion={clusterInfo?.git_version}
          onDebugStart={handleDebugStart}
        />
      )}
    </>
  );
}
