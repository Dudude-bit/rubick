import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, MoreHorizontal } from "lucide-react";

import { DebugNodeDialog, DebugPodDialog } from "@/components/debug";
import { PortForwardDialog } from "@/components/port-forward/PortForwardDialog";
import { DangerousConfirmDialog } from "@/components/ui/dangerous-confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import { useClusterInfo } from "@/hooks";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { commands } from "@/lib/commands";
import { normalizeTauriError } from "@/lib/error-utils";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import { STALE_TIMES } from "@/lib/refresh";
import { toKind } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import type { PeekTarget } from "@/hooks/usePeek";
import type {
  DebugResult,
  DeploymentInfo,
  PodInfo,
  ServiceInfo,
} from "@/generated/types";
import { DetailAction } from "./detail-blocks";
import {
  deleteCommandFor,
  describeBareRestart,
  describeDeletion,
  peekMutationKeys,
  planPeekActions,
  reachableContainer,
  type ForwardBackend,
  type PeekAction,
  type PeekActionId,
} from "./peek-actions";
import { ScaleDialog } from "./ScaleDialog";

/**
 * The peek panel's action row, and every dialog it opens.
 *
 * Two rules shape it. Nothing here reimplements a surface a detail page
 * already has — the debug, port-forward, scale and confirm dialogs are the
 * same components, mounted from a drawer instead of a page. And a shell does
 * not open here at all: a terminal in a 440px column is about fifty columns
 * wide, and half the tools anyone opens a shell to run assume eighty. That
 * one leaves for the pod's page, where the terminal is full width and the
 * session shows up in the activity panel like every other one.
 */

export interface PeekActionsProps {
  target: PeekTarget;
  /** The object the panel's own query fetched; undefined until it lands. */
  detail: unknown;
  /** Absent for a kind with no page of its own. */
  onOpenFullPage?: () => void;
  /** Closes the panel. A peek onto a deleted object is a ghost. */
  onClose: () => void;
}

export function PeekActions({
  target,
  detail,
  onOpenFullPage,
  onClose,
}: PeekActionsProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useCopyToClipboard();
  const { toast } = useToast();
  const { data: clusterInfo } = useClusterInfo();

  const kind = toKind(target.kind) ?? target.kind;
  const namespace = target.namespace ?? null;
  const pod = kind === "Pod" ? (detail as PodInfo | undefined) : undefined;
  const service =
    kind === "Service" ? (detail as ServiceInfo | undefined) : undefined;

  const [dialog, setDialog] = useState<
    "debug" | "portForward" | "scale" | null
  >(null);
  const [confirming, setConfirming] = useState<"delete" | "restart" | null>(
    null
  );

  // A Service does not answer a port-forward; the pod behind it does. Which
  // pod that is only exists in its endpoints, so it has to be read before the
  // action can honestly claim it will work.
  const backendQuery = useQuery({
    queryKey: ["peek-service-backend", namespace, target.name],
    queryFn: () => resolveServiceBackend(target.name, namespace!, service!),
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
      title: `Could not ${verb} ${target.name}`,
      description: normalizeTauriError(error),
      variant: "destructive",
    });

  const restart = useMutation({
    mutationFn: () =>
      kind === "Deployment"
        ? commands.restartDeployment(target.name, namespace)
        : commands.restartPod(target.name, namespace),
    // No success toast: the panel stays open on the object and the list behind
    // it moves. A banner saying what already happened on screen is noise.
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
      return command(target.name, namespace);
    },
    onSuccess: () => {
      invalidate();
      setConfirming(null);
      onClose();
    },
    onError: failed("delete"),
  });

  const scale = useMutation({
    mutationFn: (replicas: number) =>
      commands.scaleDeployment(target.name, replicas, namespace),
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
    const container = reachableContainer(pod) ?? pod?.containers[0];
    if (!container) return;
    navigate(
      `${getResourceDetailUrl("Pod", target.name, namespace)}?shell=${encodeURIComponent(container.name)}`
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

  const deletion = describeDeletion(kind, target.name, namespace, detail);
  const bareRestart = describeBareRestart(target.name, namespace);

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {onOpenFullPage && (
          <>
            <DetailAction
              label="Open full page"
              icon={ExternalLink}
              onClick={onOpenFullPage}
            />
            <Kbd shortcut="enter" />
          </>
        )}
        <DetailAction
          label="Copy name"
          icon={Copy}
          onClick={() => copy(target.name, `${target.name} copied`)}
        />
        {plan.inline.map((action) => (
          <PeekActionButton
            key={action.id}
            action={action}
            busy={busy[action.id]}
            onRun={() => run(action.id)}
          />
        ))}
        {plan.menu.length > 0 && (
          <PeekActionMenu actions={plan.menu} busy={busy} onRun={run} />
        )}
      </div>

      {pod && (
        <DebugPodDialog
          open={dialog === "debug"}
          onOpenChange={(open) => setDialog(open ? "debug" : null)}
          podName={pod.name}
          namespace={pod.namespace}
          containers={pod.containers.map((container) => container.name)}
          kubernetesVersion={clusterInfo?.git_version}
          onDebugStart={handleDebugStart}
        />
      )}

      {kind === "Node" && (
        <DebugNodeDialog
          open={dialog === "debug"}
          onOpenChange={(open) => setDialog(open ? "debug" : null)}
          nodeName={target.name}
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

      {kind === "Deployment" && (
        <ScaleDialog
          open={dialog === "scale"}
          onOpenChange={(open) => setDialog(open ? "scale" : null)}
          kind={kind}
          current={
            (detail as DeploymentInfo | undefined)?.replicas.desired ?? 0
          }
          busy={scale.isPending}
          onSubmit={(replicas) => scale.mutate(replicas)}
        />
      )}

      <DangerousConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
        title={deletion.title}
        description={deletion.description}
        confirmationText={target.name}
        confirmLabel="Delete"
        isLoading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />

      <DangerousConfirmDialog
        open={confirming === "restart"}
        onOpenChange={(open) => setConfirming(open ? "restart" : null)}
        title={bareRestart.title}
        description={bareRestart.description}
        confirmationText={target.name}
        confirmLabel="Restart"
        isLoading={restart.isPending}
        onConfirm={() => restart.mutate()}
      />
    </>
  );
}

/** The port a forward to this pod would default to: the first one declared. */
function podForward(pod: PodInfo | undefined): ForwardBackend | null {
  if (!pod) return null;
  const port = pod.containers.flatMap((container) => container.ports)[0];
  return port ? { podName: pod.name, port: port.containerPort } : null;
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

function PeekActionButton({
  action,
  busy,
  onRun,
}: {
  action: PeekAction;
  busy?: boolean;
  onRun: () => void;
}) {
  const control = (
    <DetailAction
      label={action.label}
      icon={action.icon}
      onClick={onRun}
      busy={busy}
      danger={action.danger}
      reason={action.reason}
    />
  );
  if (!action.reason) return control;

  return (
    // Faster than the default second: this is not a hint about a control, it
    // is the answer to why the control did nothing.
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      <TooltipContent className="max-w-[260px]">{action.reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Where the rare and the destructive go once a kind has more actions than a
 * header row can carry. Delete keeps the error colour it wears on the detail
 * pages — folding it away must not also disguise it.
 */
function PeekActionMenu({
  actions,
  busy,
  onRun,
}: {
  actions: PeekAction[];
  busy: Partial<Record<PeekActionId, boolean>>;
  onRun: (id: PeekActionId) => void;
}) {
  return (
    // Not modal: the panel it sits in is not modal either, and a menu that
    // makes the list behind it inert would undo that.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <DetailAction
          label="More"
          icon={MoreHorizontal}
          onClick={() => {}}
          aria-label="More actions"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[180px]">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.id}
            disabled={!!action.reason || busy[action.id]}
            onSelect={() => onRun(action.id)}
            className={cn("gap-1.5", action.danger && "text-err")}
          >
            <action.icon className="h-3.5 w-3.5" />
            <span className="flex min-w-0 flex-col">
              {action.label}
              {action.reason && (
                <span className="text-[11px] text-fg-fnt">{action.reason}</span>
              )}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
