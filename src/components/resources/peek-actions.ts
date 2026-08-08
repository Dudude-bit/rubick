import {
  Bug,
  Network,
  RefreshCw,
  Scale,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { commands } from "@/lib/commands";
import {
  podContainers,
  podPorts,
  shellTargets,
} from "@/lib/container-sequence";
import { toKind, toPlural, type ResourceKind } from "@/lib/resource-registry";
import type { DeploymentInfo, PodInfo, ServiceInfo } from "@/generated/types";

/**
 * What the peek panel lets you *do* to the object it is showing.
 *
 * The split from the panel is deliberate: which actions a kind has, and why
 * one of them cannot run right now, is a question about Kubernetes, not about
 * React. It answers here, in one place, testable without a DOM — the panel
 * only has to render the answer and own the dialogs.
 *
 * Nothing here pre-flights access. The app has no SelfSubjectAccessReview
 * anywhere, so an RBAC refusal surfaces the same way it does on every detail
 * page: the call is made, it fails, and the error says so. A second, weaker
 * convention that greys buttons out on a guess would disagree with the first
 * one in exactly the cases that matter.
 */

export type PeekActionId =
  | "shell"
  | "debug"
  | "portForward"
  | "restart"
  | "scale"
  | "delete";

export interface PeekAction {
  id: PeekActionId;
  label: string;
  icon: LucideIcon;
  /** Reads in the error colour and is confirmed by typing the object's name. */
  danger?: boolean;
  /**
   * Why this cannot run on this object as it stands. The control stays in the
   * row and says it; it does not vanish, and it does not fail on click.
   */
  reason?: string;
}

export interface PeekActionPlan {
  inline: PeekAction[];
  /** Rare and destructive, folded away once the row would be a wall. */
  menu: PeekAction[];
}

/** Where a port forward would actually land, once a Service is resolved. */
export interface ForwardBackend {
  podName: string;
  port: number;
}

export interface PeekActionContext {
  /** Service only: the pod behind it, or why that could not be worked out. */
  backend?: ForwardBackend | null;
  backendPending?: boolean;
  backendError?: string | null;
}

/** Open full page and Copy name; the panel shows them for every kind. */
const ALWAYS_SHOWN = 2;
/** Past this the row stops being scannable, so the secondary ones fold away. */
const INLINE_LIMIT = 5;
const SECONDARY = new Set<PeekActionId>(["debug", "restart", "delete"]);

export function planPeekActions(
  kind: string,
  detail: unknown,
  context: PeekActionContext = {}
): PeekActionPlan {
  const resolved = toKind(kind);
  const actions = resolved ? actionsFor(resolved, detail, context) : [];

  if (ALWAYS_SHOWN + actions.length <= INLINE_LIMIT) {
    return { inline: actions, menu: [] };
  }
  return {
    inline: actions.filter((action) => !SECONDARY.has(action.id)),
    menu: actions.filter((action) => SECONDARY.has(action.id)),
  };
}

function actionsFor(
  kind: ResourceKind,
  detail: unknown,
  context: PeekActionContext
): PeekAction[] {
  switch (kind) {
    case "Pod":
      return podActions(detail as PodInfo | undefined);
    case "Deployment":
      return [
        { id: "scale", label: "Scale", icon: Scale },
        { id: "restart", label: "Restart", icon: RefreshCw },
        ...deleteAction(kind),
      ];
    case "Node":
      // The node page offers exactly one thing; cordon and drain exist in the
      // backend but have never had a control, and the peek is not the place
      // to introduce one.
      return [{ id: "debug", label: "Debug node", icon: Bug }];
    case "Service":
      return [
        serviceForwardAction(detail as ServiceInfo | undefined, context),
        ...deleteAction(kind),
      ];
    default:
      return deleteAction(kind);
  }
}

/* ---------- Pod ---------- */

const FINISHED_PHASES = new Set(["succeeded", "completed"]);

/**
 * The container a shell or a forward would reach.
 *
 * `shellTargets` decides both what counts and what comes first — app
 * container, then sidecar, then a running init container. On a meshed pod
 * whose app container has not come up, the sidecar is a real shell and
 * this used to report there was none.
 */
export function reachableContainer(pod: PodInfo | undefined) {
  if (!pod) return undefined;
  return shellTargets(pod)[0];
}

/** "app is waiting · ImagePullBackOff", when the API says that much. */
function waitingNote(pod: PodInfo): string {
  // Init containers included: a pod held at `Init:ImagePullBackOff` has
  // app containers that all read `PodInitializing`, and the one container
  // that knows what is wrong is in the other list.
  const waiting = podContainers(pod).find(
    (container) => container.state.type === "waiting"
  );
  if (!waiting || waiting.state.type !== "waiting") return "";
  return waiting.state.reason
    ? ` · ${waiting.name} ${waiting.state.reason}`
    : "";
}

function podActions(pod: PodInfo | undefined): PeekAction[] {
  const phase = pod?.status.phase ?? "";
  const lower = phase.toLowerCase();
  const finished = FINISHED_PHASES.has(lower);
  const failed = lower === "failed";
  const live = !!reachableContainer(pod);
  const owned = !!pod?.ownerReferences?.length;

  let shellReason: string | undefined;
  if (finished) {
    shellReason = `This pod has finished — ${phase}. There is no process left to attach a shell to.`;
  } else if (failed) {
    shellReason =
      "This pod has stopped. Its containers are gone, so there is nothing to attach to.";
  } else if (pod && !live) {
    shellReason = `No container is running yet — this pod is ${phase}${waitingNote(pod)}.`;
  }

  const declaresPorts = !!pod && podPorts(pod).length > 0;
  let forwardReason: string | undefined;
  if (pod && !declaresPorts) {
    forwardReason =
      "No container in this pod declares a port, so there is nothing to forward to.";
  } else if (pod && !live) {
    forwardReason = `Nothing is listening yet — no container is running, this pod is ${phase}${waitingNote(pod)}.`;
  }

  return [
    { id: "shell", label: "Shell", icon: Terminal, reason: shellReason },
    {
      id: "portForward",
      label: "Port forward",
      icon: Network,
      reason: forwardReason,
    },
    { id: "debug", label: "Debug", icon: Bug },
    // Restarting a pod is deleting it. With a controller above, that is a
    // replacement and reads as a restart; without one the pod simply stops
    // existing, and calling that "Restart" would be a lie told in one word.
    owned || !pod
      ? { id: "restart", label: "Restart", icon: RefreshCw }
      : {
          id: "restart",
          label: "Restart (deletes it)",
          icon: RefreshCw,
          danger: true,
        },
    ...deleteAction("Pod"),
  ];
}

/* ---------- Service ---------- */

function serviceForwardAction(
  service: ServiceInfo | undefined,
  context: PeekActionContext
): PeekAction {
  const action: PeekAction = {
    id: "portForward",
    label: "Port forward",
    icon: Network,
  };
  if (!service) return action;
  if (service.ports.length === 0) {
    return {
      ...action,
      reason: "This Service declares no ports, so there is nothing to forward.",
    };
  }
  if (context.backendError) {
    return {
      ...action,
      reason: `Could not read this Service's endpoints: ${context.backendError}`,
    };
  }
  // Still looking: the row shows it busy rather than guessing either way.
  if (context.backendPending || context.backend === undefined) return action;
  if (!context.backend) {
    return {
      ...action,
      reason:
        "No ready endpoints — nothing is behind this Service to forward to.",
    };
  }
  return action;
}

/* ---------- Delete ---------- */

type DeleteCommand = (
  name: string,
  namespace: string | null
) => Promise<unknown>;

/**
 * The kinds the backend can actually delete. A kind missing here gets no
 * Delete rather than a button that reports "no such command" on click.
 */
const DELETE_COMMANDS: Partial<Record<ResourceKind, DeleteCommand>> = {
  Pod: (name, namespace) => commands.deletePod(name, namespace, false),
  Deployment: (name, namespace) => commands.deleteDeployment(name, namespace),
  StatefulSet: (name, namespace) => commands.deleteStatefulset(name, namespace),
  DaemonSet: (name, namespace) => commands.deleteDaemonset(name, namespace),
  Job: (name, namespace) => commands.deleteJob(name, namespace),
  CronJob: (name, namespace) => commands.deleteCronjob(name, namespace),
  ConfigMap: (name, namespace) => commands.deleteConfigmap(name, namespace),
  Secret: (name, namespace) => commands.deleteSecret(name, namespace),
  Service: (name, namespace) => commands.deleteService(name, namespace),
  Ingress: (name, namespace) => commands.deleteIngress(name, namespace),
  Endpoints: (name, namespace) => commands.deleteEndpoints(name, namespace),
  PersistentVolumeClaim: (name, namespace) =>
    commands.deletePersistentVolumeClaim(name, namespace),
  PersistentVolume: (name) => commands.deletePersistentVolume(name),
  StorageClass: (name) => commands.deleteStorageClass(name),
  CustomResourceDefinition: (name) => commands.deleteCrd(name),
};

export function deleteCommandFor(kind: string): DeleteCommand | null {
  const resolved = toKind(kind);
  return (resolved && DELETE_COMMANDS[resolved]) ?? null;
}

function deleteAction(kind: ResourceKind): PeekAction[] {
  if (!DELETE_COMMANDS[kind]) return [];
  return [{ id: "delete", label: "Delete", icon: Trash2, danger: true }];
}

/* ---------- What a confirmation has to say ---------- */

export interface PeekConfirmCopy {
  title: string;
  description: string;
}

const qualified = (name: string, namespace: string | null) =>
  namespace ? `${namespace}/${name}` : name;

/**
 * "Are you sure?" asks nothing. Naming the object and what goes with it is
 * the only wording that lets a reader catch the wrong row before typing.
 */
export function describeDeletion(
  kind: string,
  name: string,
  namespace: string | null,
  detail: unknown
): PeekConfirmCopy {
  const resolved = toKind(kind) ?? kind;
  const subject = `${resolved.toLowerCase()} ${qualified(name, namespace)}`;
  return {
    title: `Delete ${subject}?`,
    description: `Deleting ${subject} ${deletionEffect(resolved, detail)}`,
  };
}

function deletionEffect(kind: string, detail: unknown): string {
  switch (kind) {
    case "Pod": {
      const owner = (detail as PodInfo | undefined)?.ownerReferences?.[0];
      return owner
        ? `removes it now. Its ${owner.kind} ${owner.name} will start a replacement.`
        : "removes it now. Nothing owns this pod, so nothing will bring it back.";
    }
    case "Deployment": {
      const desired = (detail as DeploymentInfo | undefined)?.replicas.desired;
      return desired
        ? `removes it and the ${desired} pod${desired === 1 ? "" : "s"} it runs.`
        : "removes it and every pod it runs.";
    }
    case "StatefulSet":
      return "removes it and its pods. The PersistentVolumeClaims it created stay behind and keep costing.";
    case "DaemonSet":
      return "removes it and its pod on every node it runs on.";
    case "Job":
      return "removes it and the pods it created, including their logs.";
    case "CronJob":
      return "stops the schedule and removes it. Jobs it has already created stay behind.";
    case "Service":
      return "removes its address. Anything resolving this name stops reaching these pods.";
    case "ConfigMap":
    case "Secret":
      return "leaves running pods alone, but any pod that mounts it will fail to start until it is recreated.";
    case "PersistentVolumeClaim":
      return "releases the volume. Depending on the storage class's reclaim policy the data may be erased.";
    case "PersistentVolume":
      return "removes the volume object. Whether the data survives is up to its reclaim policy.";
    default:
      return "is permanent and cannot be undone.";
  }
}

/**
 * The confirmation a bare pod's restart needs. Owned pods get none: the
 * controller replaces them and the panel stays honest by doing it silently.
 */
export function describeBareRestart(
  name: string,
  namespace: string | null
): PeekConfirmCopy {
  const subject = `pod ${qualified(name, namespace)}`;
  return {
    title: `Restart ${subject}?`,
    description: `Restarting a pod means deleting it. Nothing owns ${subject}, so nothing will recreate it — this removes the pod for good.`,
  };
}

/**
 * What a mutation from the panel has to make stale.
 *
 * The panel is not modal: the list it was opened from is still on screen
 * behind it, so a row that keeps its old state after a delete is the first
 * thing anyone notices. Both key shapes in the app are covered — the lists
 * and `queryKeys.resourceDetail` are plural-first, the detail pages'
 * `useResourceDetail` is singular-first — plus the panel's own queries.
 */
export function peekMutationKeys(kind: string): string[][] {
  const resolved = toKind(kind) ?? kind;
  return [
    [toPlural(resolved as ResourceKind)],
    [resolved.toLowerCase()],
    // Every mutation the panel offers ends in pods changing, and the pod list
    // is the one most likely to be the view behind it.
    ["pods"],
    ["peek"],
    ["peek-pods"],
    ["peek-jobs"],
    ["peek-events"],
    ["peek-yaml"],
  ];
}
