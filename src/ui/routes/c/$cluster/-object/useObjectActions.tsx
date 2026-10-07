/**
 * Everything the app can *do* to one object, and every dialog that does it.
 *
 * `peek-actions.ts` already answers which actions a kind has and why one of
 * them cannot run — a question about Kubernetes, testable without a DOM. This
 * is the layer under it: the mutations, the four dialogs, the two
 * confirmations, and the invalidation that keeps the list behind them honest.
 *
 * It is a hook rather than a component because it now has two callers with
 * nothing else in common. The peek panel draws these as a row of buttons in
 * its header; a table row draws them as a menu. Both owe the same
 * confirmations, the same delivery warning and the same "why this is greyed
 * out" sentence, and a second copy of any of those is how one surface starts
 * telling the reader an edit is safe while the other says it will be reverted.
 *
 * **Mount it once per surface, never per row.** It holds two queries and four
 * mutations; a table that instantiated it per row would open five hundred
 * subscriptions to draw one page. `planPeekActions` is pure and cheap and is
 * what a row should call to decide whether it has a menu at all.
 */

import { useCallback, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { DebugNodeDialog, DebugPodDialog } from "../-debug";
import {
  PortForwardDialog,
  type ForwardTarget,
} from "@/components/port-forward/PortForwardDialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DeletionDialog } from "./DeleteAction";
import { useClusterInfo } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useCritical } from "@/hooks/useCritical";
import { useDeliveryIntercept } from "../-delivery/useDelivery";
import { commands } from "@/lib/commands";
import { lifetimeContainers } from "@/lib/container-sequence";
import { podForwardPorts } from "@/lib/port-forward";
import { deliveryOfKind } from "@/lib/delivery";
import { errorToShow } from "@/lib/error-utils";
import { scaleWarnings } from "@/lib/governance";
import { readinessOf } from "@/lib/restart-plan";
import { objectLink } from "@/lib/links";
import { STALE_TIMES } from "@/lib/refresh";
import { toKind } from "@/lib/resource-registry";
import type {
  DebugResult,
  DeploymentInfo,
  PodInfo,
  RolloutPlan,
  ServiceInfo,
  StatefulSetDetailInfo,
} from "@/generated/types";

import { ScaleDialog } from "./ScaleDialog";
import { RestartDialog } from "./RestartDialog";
import {
  deleteCommandFor,
  peekMutationKeys,
  planPeekActions,
  qualified,
  reachableContainer,
  restartCommandFor,
  restartNeedsAsking,
  restartRollsOut,
  scaleCommandFor,
  warned,
  type ForwardBackend,
  type PeekActionId,
  type PeekActionPlan,
} from "../-peek/peek-actions";
import { useAsk } from "./useAsk";
import { guardedOf, noteDenied, useDenied, usePodDenied } from "@/lib/access";
import { askableKind } from "@/lib/tell-me-when";
import { useT } from "@/i18n/useT";
import { toastError } from "@/lib/toast-error";
import { toast } from "@/components/ui/use-toast";

/** Whatever the surface fetched, seen only as the count the dialog seeds from. */
type ScalableInfo = DeploymentInfo | StatefulSetDetailInfo;

export interface ObjectActions {
  plan: PeekActionPlan;
  busy: Partial<Record<PeekActionId, boolean>>;
  run: (id: PeekActionId) => void;
  /** Opens the delete confirmation; holds still, unlike `run`. */
  askDelete: () => void;
  /** Mount once, wherever the caller renders. Nothing draws without it. */
  dialogs: ReactNode;
}

export interface ObjectActionsOptions {
  kind: string;
  name: string;
  namespace: string | null;
  /** The object itself, where the surface has it. Undefined narrows nothing. */
  detail: unknown;
  /** Called once a delete lands: the peek closes on it, a table row does not. */
  onGone?: () => void;
}

export function useObjectActions({
  kind: rawKind,
  name,
  namespace,
  detail,
  onGone,
}: ObjectActionsOptions): ObjectActions {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: clusterInfo } = useClusterInfo();
  const critical = useCritical();
  const criticalActive = critical.critical && !!critical.context;

  const kind = toKind(rawKind) ?? rawKind;
  const pod = kind === "Pod" ? (detail as PodInfo | undefined) : undefined;
  const service =
    kind === "Service" ? (detail as ServiceInfo | undefined) : undefined;

  // Every surface carrying these controls owes the same warning. A dialog that
  // said an edit would be reverted in one place and not the other would teach
  // the reader that silence means "safe" — which is the belief this whole
  // feature exists to prevent.
  const intercept = useDeliveryIntercept(
    deliveryOfKind(
      kind,
      detail as
        | {
            name: string;
            namespace?: string | null;
            labels?: Record<string, string>;
            annotations?: Record<string, string>;
          }
        | undefined
    )
  );

  const [dialog, setDialog] = useState<
    "debug" | "portForward" | "scale" | null
  >(null);
  const [confirming, setConfirming] = useState<
    "delete" | "restart" | "rolling" | "managedRestart" | null
  >(null);

  // Asked for only once the dialog is open — a neighbourhood read on every row
  // somebody arrows past would be six lists per keystroke, and the query key
  // is the page's, so an already-open Deployment answers from cache.
  const governance = useConnections(kind, name, namespace, dialog === "scale");

  // A Service does not answer a port-forward; the pod behind it does. Which
  // pod that is only exists in its endpoints, so it has to be read before the
  // action can honestly claim it will work.
  const backendQuery = useQuery({
    queryKey: ["peek-service-backend", namespace, name],
    queryFn: () => resolveServiceBackend(name, namespace!, service!),
    enabled: !!service && !!namespace && service.ports.length > 0,
    staleTime: STALE_TIMES.fast,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const invalidate = () => {
    for (const queryKey of peekMutationKeys(kind)) {
      queryClient.invalidateQueries({ queryKey });
    }
  };

  const guarded = guardedOf(kind, namespace);
  const denied = useDenied(guarded);
  const podDenied = usePodDenied(
    kind === "Pod" || kind === "Service" ? namespace : null
  );
  const verbOf = {
    delete: "delete",
    scale: "patch",
    restart: kind === "Pod" ? "delete" : "patch",
  } as const;

  const failed = (verb: "restart" | "delete" | "scale") => (error: unknown) => {
    noteDenied(verbOf[verb], guarded, error);
    toastError(
      t("action", "couldNotDo", {
        action: t("action", verb).toLowerCase(),
        name,
      }),
      error
    );
  };

  const asking = useAsk();
  const askTarget = (() => {
    const askable = askableKind(kind);
    return askable ? { kind: askable, namespace, name } : null;
  })();

  /**
   * The object's generation as the panel last read it, or `null` where the
   * detail has not loaded — which is the honest answer, and the one
   * `acknowledged` already handles.
   */
  const generationOf = (object: unknown): number | null => {
    if (!object || typeof object !== "object") return null;
    const value = (object as { generation?: number | null }).generation;
    return typeof value === "number" ? value : null;
  };

  const restart = useMutation({
    mutationFn: async () => {
      // The same table the offer came from, so the button and the command
      // cannot name different kinds.
      const roll = restartCommandFor(kind);
      if (!roll) return;
      await roll(name, namespace);
    },
    onSuccess: () => {
      invalidate();
      setConfirming(null);
      toast({
        title: t("action", "kindRestarted", { kind }),
        description: t("action", "kindRestartingDetail", { kind, name }),
      });
      // Every rolled workload is followed to its answer, not just the one
      // kind that could be rolled when this was written — the detail pages
      // follow all three, and a peek that did not would answer differently
      // for the same click. A restarted pod is the exception because it is
      // a deletion: the pod that replaces it is a different object.
      if (askTarget && kind !== "Pod") {
        asking.ask(askTarget, {
          action: "restart",
          replicas: null,
          // The generation the panel already had. Without it `acknowledged`
          // has only "did I see it unsettled" to go on, and a rollout that
          // is already finished by the first watch event — a small one, or
          // one with nothing to roll — is never recognised as this click's,
          // so the watch times out on a restart that worked.
          generationBefore: generationOf(detail),
        });
      }
    },
    onError: failed("restart"),
  });

  const remove = useMutation({
    mutationFn: () => {
      const command = deleteCommandFor(kind);
      if (!command) throw new Error(`No delete command for ${kind}`);
      return command(name, namespace);
    },
    onSuccess: () => {
      invalidate();
      setConfirming(null);
      toast({
        title: t("action", "kindDeleted", { kind }),
        description: t("action", "kindDeletedDetail", { kind, name }),
      });
      onGone?.();
    },
    onError: failed("delete"),
  });

  const scaleCommand = scaleCommandFor(kind);

  const scale = useMutation({
    mutationFn: (replicas: number) => {
      if (!scaleCommand) throw new Error(`No scale command for ${kind}`);
      return scaleCommand(name, replicas, namespace);
    },
    onSuccess: (_, replicas) => {
      invalidate();
      setDialog(null);
      toast({
        title: t("action", "kindScaled", { kind }),
        description: t("action", "kindScaledDetail", {
          kind,
          name,
          n: replicas,
        }),
      });
    },
    onError: failed("scale"),
  });

  const plan = planPeekActions(kind, detail, t, {
    watching: askTarget ? asking.watching(askTarget) : false,
    backend: backendQuery.data,
    backendPending:
      backendQuery.isPending && backendQuery.fetchStatus !== "idle",
    backendError: backendQuery.error ? errorToShow(backendQuery.error) : null,
    denied: {
      delete: denied[verbOf.delete],
      scale: denied[verbOf.scale],
      restart: denied[verbOf.restart],
      debug: kind === "Pod" ? podDenied.debug : undefined,
      shell: podDenied.shell,
      portForward: podDenied.portForward,
    },
  });

  const busy: Partial<Record<PeekActionId, boolean>> = {
    restart: restart.isPending,
    delete: remove.isPending,
    portForward: !!service && backendQuery.isFetching,
  };

  const openShell = () => {
    const container =
      reachableContainer(pod) ?? (pod ? lifetimeContainers(pod)[0] : undefined);
    if (!container) return;
    navigate({
      ...objectLink({ kind: "Pod", name, namespace })!,
      search: { shell: container.name },
    });
  };

  const handleDebugStart = (result: DebugResult) => {
    setDialog(null);
    navigate({
      ...objectLink({
        kind: "Pod",
        name: result.podName,
        namespace: result.namespace,
      })!,
      ...(result.isNewPod ? {} : { search: { shell: result.containerName } }),
    });
  };

  const askDelete = useCallback(() => setConfirming("delete"), []);

  const run = (id: PeekActionId) => {
    switch (id) {
      case "shell":
        return openShell();
      case "debug":
        return setDialog("debug");
      case "portForward":
        return setDialog("portForward");
      case "scale":
        return setDialog("scale");
      case "restart":
        // A pod's restart is its deletion, owned or not.
        if (kind === "Pod") return setConfirming("restart");
        if (restartRollsOut(kind)) return setConfirming("rolling");
        // A managed restart is reversible, but it still asks when a delivery
        // controller would undo it or the cluster is marked critical — the
        // same rule the page applies, so the two surfaces cannot disagree
        // about the same click.
        return restartNeedsAsking(intercept("Restart") !== null, criticalActive)
          ? setConfirming("managedRestart")
          : restart.mutate();
      case "delete":
        return askDelete();
      case "tell":
        if (!askTarget) return;
        return asking.watching(askTarget)
          ? asking.stop(askTarget)
          : asking.ask(askTarget);
    }
  };

  const forward: ForwardTarget | null =
    service && namespace
      ? {
          kind: "Service",
          name: service.name,
          namespace,
          ports: service.ports.map((port) => ({
            port: port.port,
            name: port.name,
            protocol: port.protocol,
          })),
        }
      : pod
        ? {
            kind: "Pod",
            name: pod.name,
            namespace: pod.namespace,
            ports: podForwardPorts(pod),
          }
        : null;

  const dialogs = (
    <>
      {asking.dialog}
      {pod && (
        <DebugPodDialog
          open={dialog === "debug"}
          onOpenChange={(open) => setDialog(open ? "debug" : null)}
          podName={pod.name}
          namespace={pod.namespace}
          containers={lifetimeContainers(pod).map(
            (container) => container.name
          )}
          kubernetesVersion={clusterInfo?.git_version}
          onDebugStart={handleDebugStart}
        />
      )}

      {kind === "Node" && (
        <DebugNodeDialog
          open={dialog === "debug"}
          onOpenChange={(open) => setDialog(open ? "debug" : null)}
          nodeName={name}
          onDebugStart={handleDebugStart}
        />
      )}

      {forward && (
        <PortForwardDialog
          open={dialog === "portForward"}
          onOpenChange={(open) => setDialog(open ? "portForward" : null)}
          target={forward}
        />
      )}

      {scaleCommand && (
        <ScaleDialog
          open={dialog === "scale"}
          onOpenChange={(open) => setDialog(open ? "scale" : null)}
          kind={kind}
          name={name}
          namespace={namespace}
          current={(detail as ScalableInfo | undefined)?.replicas.desired}
          busy={scale.isPending}
          warnings={scaleWarnings(governance.data, intercept("Scale"), t)}
          onSubmit={(replicas) => scale.mutate(replicas)}
        />
      )}

      <DeletionDialog
        open={confirming === "delete"}
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
        kind={kind}
        name={name}
        namespace={namespace}
        detail={detail}
        intercept={intercept("Delete")}
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />

      {kind === "Pod" && (
        <DeletionDialog
          restart
          open={confirming === "restart"}
          onOpenChange={(open) => setConfirming(open ? "restart" : null)}
          kind={kind}
          name={name}
          namespace={namespace}
          detail={detail}
          intercept={intercept("Restart")}
          busy={restart.isPending}
          onConfirm={() => restart.mutate()}
        />
      )}

      {restartRollsOut(kind) && (
        <RestartDialog
          open={confirming === "rolling"}
          onOpenChange={(open) => setConfirming(open ? "rolling" : null)}
          kind={kind}
          name={name}
          namespace={namespace}
          plan={
            (detail as { rolloutPlan?: RolloutPlan } | undefined)?.rolloutPlan
          }
          readiness={readinessOf(detail)}
          intercept={intercept("Restart")}
          busy={restart.isPending}
          onConfirm={() => restart.mutate()}
        />
      )}

      {/* A reversible restart has no object-name gate of its own, so this only
          ever opens on a critical cluster, where the ConfirmDialog grows the
          typed-name gate itself. Warned like the others where a controller
          would also undo it. */}
      <ConfirmDialog
        open={confirming === "managedRestart"}
        onOpenChange={(open) => setConfirming(open ? "managedRestart" : null)}
        title={t("action", "restartSubjectTitle", {
          subject: `${kind} ${qualified(name, namespace)}`,
        })}
        description={warned("", intercept("Restart")).trim() || undefined}
        confirmLabel={t("action", "restart")}
        confirmVariant="destructive"
        confirmDisabled={restart.isPending}
        onConfirm={() => restart.mutate()}
      />
    </>
  );

  return { plan, busy, run, askDelete, dialogs };
}

async function resolveServiceBackend(
  name: string,
  namespace: string,
  service: ServiceInfo
): Promise<ForwardBackend | null> {
  const endpoints = await commands.getEndpoints(name, namespace);
  for (const subset of endpoints.subsets) {
    const address = subset.addresses.find(
      (entry) => entry.targetRef?.kind === "Pod"
    );
    if (!address?.targetRef) continue;
    const port = subset.ports[0]?.port ?? service.ports[0]?.port;
    if (port === undefined) continue;
    return { podName: address.targetRef.name, port };
  }
  return null;
}
