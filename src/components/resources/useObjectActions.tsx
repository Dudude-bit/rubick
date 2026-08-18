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

import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { DebugNodeDialog, DebugPodDialog } from "@/components/debug";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import { useToast } from "@/components/ui/use-toast";
import { useClusterInfo } from "@/hooks";
import { useConnections } from "@/hooks/useConnections";
import { useDeliveryIntercept } from "@/hooks/useDelivery";
import { commands } from "@/lib/commands";
import { lifetimeContainers, podPorts } from "@/lib/container-sequence";
import { deliveryOfKind } from "@/lib/delivery";
import { normalizeTauriError } from "@/lib/error-utils";
import { scaleWarnings } from "@/lib/governance";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { toKind } from "@/lib/resource-registry";
import type {
  DebugResult,
  DeploymentInfo,
  PodInfo,
  ServiceInfo,
  StatefulSetDetailInfo,
} from "@/generated/types";

import { ScaleDialog } from "./ScaleDialog";
import {
  deleteCommandFor,
  describeBareRestart,
  describeDeletion,
  peekMutationKeys,
  planPeekActions,
  reachableContainer,
  scaleCommandFor,
  type ForwardBackend,
  type PeekActionId,
  type PeekActionPlan,
} from "./peek-actions";
import { useT } from "@/i18n/useT";

/** Whatever the surface fetched, seen only as the count the dialog seeds from. */
type ScalableInfo = DeploymentInfo | StatefulSetDetailInfo;

export interface ObjectActions {
  plan: PeekActionPlan;
  busy: Partial<Record<PeekActionId, boolean>>;
  run: (id: PeekActionId) => void;
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

/**
 * The confirmation's own sentence, and what delivery adds to it.
 *
 * Prepended rather than replacing: "this deletes the object" is still true,
 * and "and the controller puts it straight back" is the part that changes what
 * you would do.
 */
function warned(
  description: string,
  intercept: { lead: string; description: string } | null
): string {
  return intercept
    ? `${intercept.lead} ${intercept.description} ${description}`
    : description;
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
  const { toast } = useToast();
  const { data: clusterInfo } = useClusterInfo();

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
  const [confirming, setConfirming] = useState<"delete" | "restart" | null>(
    null
  );

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

  const failed = (verb: string) => (error: unknown) =>
    toast({
      title: `Could not ${verb} ${name}`,
      description: normalizeTauriError(error),
      variant: "destructive",
    });

  const restart = useMutation({
    mutationFn: () =>
      kind === "Deployment"
        ? commands.restartDeployment(name, namespace)
        : commands.restartPod(name, namespace),
    // No success toast: the surface stays on the object and the list moves. A
    // banner saying what already happened on screen is noise.
    onSuccess: () => {
      invalidate();
      setConfirming(null);
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
    onSuccess: () => {
      invalidate();
      setDialog(null);
    },
    onError: failed("scale"),
  });

  const plan = planPeekActions(kind, detail, {
    backend: backendQuery.data,
    backendPending:
      backendQuery.isPending && backendQuery.fetchStatus !== "idle",
    backendError: backendQuery.error
      ? normalizeTauriError(backendQuery.error)
      : null,
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
    navigate(
      `${getResourceDetailUrl("Pod", name, namespace)}?shell=${encodeURIComponent(container.name)}`
    );
  };

  const handleDebugStart = (result: DebugResult) => {
    setDialog(null);
    navigate(
      `${getResourceDetailUrl("Pod", result.podName, result.namespace)}${
        result.isNewPod
          ? ""
          : `?shell=${encodeURIComponent(result.containerName)}`
      }`
    );
  };

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
        // A bare pod has no controller to put it back, so its "restart" is a
        // one-way door and gets the same gate as a delete.
        return kind === "Pod" && !pod?.ownerReferences?.length
          ? setConfirming("restart")
          : restart.mutate();
      case "delete":
        return setConfirming("delete");
    }
  };

  const forward = service
    ? backendQuery.data
      ? { podName: backendQuery.data.podName, port: backendQuery.data.port }
      : null
    : podForward(pod);

  const deletion = describeDeletion(kind, name, namespace, detail);
  const bareRestart = describeBareRestart(name, namespace);

  const dialogs = (
    <>
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

      {forward && namespace && (
        <PortForwardDialog
          open={dialog === "portForward"}
          onOpenChange={(open) => setDialog(open ? "portForward" : null)}
          podName={forward.podName}
          podNamespace={namespace}
          initialPort={forward.port}
          portName={service ? `${service.name}:${forward.port}` : undefined}
        />
      )}

      {scaleCommand && (
        <ScaleDialog
          open={dialog === "scale"}
          onOpenChange={(open) => setDialog(open ? "scale" : null)}
          kind={kind}
          current={(detail as ScalableInfo | undefined)?.replicas.desired ?? 0}
          busy={scale.isPending}
          warnings={scaleWarnings(governance.data, intercept("Scale"))}
          onSubmit={(replicas) => scale.mutate(replicas)}
        />
      )}

      <DangerousConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
        title={deletion.title}
        description={warned(deletion.description, intercept("Delete"))}
        confirmationText={name}
        confirmLabel={t("action", "delete")}
        isLoading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />

      <DangerousConfirmDialog
        open={confirming === "restart"}
        onOpenChange={(open) => setConfirming(open ? "restart" : null)}
        title={bareRestart.title}
        description={warned(bareRestart.description, intercept("Restart"))}
        confirmationText={name}
        confirmLabel="Restart"
        isLoading={restart.isPending}
        onConfirm={() => restart.mutate()}
      />
    </>
  );

  return { plan, busy, run, dialogs };
}

/**
 * The port a forward to this pod would default to: the first one the app
 * containers declare, and only then a sidecar's — `podPorts` puts them in
 * that order, so the default is the reader's own port rather than the
 * proxy that was injected beside it.
 */
function podForward(pod: PodInfo | undefined): ForwardBackend | null {
  if (!pod) return null;
  const first = podPorts(pod)[0];
  return first ? { podName: pod.name, port: first.port.containerPort } : null;
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
