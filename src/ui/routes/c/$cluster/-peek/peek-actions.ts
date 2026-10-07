import {
  Bell,
  BellOff,
  Bug,
  Network,
  RefreshCw,
  Scale,
  Terminal,
  Trash2,
  type LucideIcon,
} from "lucide-react";

import { commands } from "@/lib/commands";
import { queryKeys } from "@/lib/query-keys";
import {
  podContainers,
  podPorts,
  shellTargets,
} from "@/lib/container-sequence";
import {
  isScalable,
  ResourceType,
  toKind,
  type ResourceKind,
  type ScalableKind,
} from "@/lib/resource-registry";
import { askableKind } from "@/lib/tell-me-when";
import type {
  PodInfo,
  ServiceInfo,
  StatefulSetDetailInfo,
} from "@/generated/types";
import type { T } from "@/i18n/useT";

/**
 * What the peek panel lets you *do* to the object it is showing.
 *
 * The split from the panel is deliberate: which actions a kind has, and why
 * one of them cannot run right now, is a question about Kubernetes, not about
 * React. It answers here, in one place, testable without a DOM — the panel
 * only has to render the answer and own the dialogs.
 *
 * A destructive action the cluster's access review refuses arrives in
 * `denied` and stays in the row, greyed, saying so: a red Delete offered to
 * someone who may not delete is a promise the click then breaks. A review
 * that could not be asked denies nothing, so nothing is shut on a guess.
 */

export type PeekActionId =
  | "shell"
  | "debug"
  | "portForward"
  | "restart"
  | "scale"
  | "delete"
  | "tell";

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
  /** A "tell me when" is already open on this object. */
  watching?: boolean;
  /** Why the access review says this user may not run an action. */
  denied?: Partial<Record<PeekActionId, string>>;
}

/** Open full page and Copy name; the panel shows them for every kind. */
const ALWAYS_SHOWN = 2;
/** Past this the row stops being scannable, so the secondary ones fold away. */
const INLINE_LIMIT = 5;
const SECONDARY = new Set<PeekActionId>(["debug", "restart", "delete"]);

export function planPeekActions(
  kind: string,
  detail: unknown,
  t: T,
  context: PeekActionContext = {}
): PeekActionPlan {
  const resolved = toKind(kind);
  const actions = (
    resolved ? actionsFor(resolved, detail, t, context) : []
  ).map((action) => {
    const denied = context.denied?.[action.id];
    return denied ? { ...action, reason: denied } : action;
  });
  // The bell is asked about a lot less than it is glanced at, so it does not
  // count towards the fold: a row stays whole with it, and folds without it.
  const tell = tellAction(kind, t, context);

  if (ALWAYS_SHOWN + actions.length <= INLINE_LIMIT) {
    return { inline: [...actions, ...tell], menu: [] };
  }
  return {
    inline: actions.filter((action) => !SECONDARY.has(action.id)),
    menu: [...actions.filter((action) => SECONDARY.has(action.id)), ...tell],
  };
}

function actionsFor(
  kind: ResourceKind,
  detail: unknown,
  t: T,
  context: PeekActionContext
): PeekAction[] {
  switch (kind) {
    case "Pod":
      return podActions(detail as PodInfo | undefined, t);
    case "Deployment":
    case "StatefulSet":
      return [
        ...scaleAction(kind, t),
        ...restartAction(kind, t),
        ...deleteAction(kind, t),
      ];
    // No replicas to scale: a DaemonSet's count is how many nodes it fits.
    case "DaemonSet":
      return [...restartAction(kind, t), ...deleteAction(kind, t)];
    case "Node":
      // The node page offers exactly one thing; cordon and drain exist in the
      // backend but have never had a control, and the peek is not the place
      // to introduce one.
      return [{ id: "debug", label: t("action", "debugNode"), icon: Bug }];
    case "Service":
      return [
        serviceForwardAction(detail as ServiceInfo | undefined, t, context),
        ...deleteAction(kind, t),
      ];
    default:
      return [...scaleAction(kind, t), ...deleteAction(kind, t)];
  }
}

/* ---------- Tell me when ---------- */

/** The question is the kind's; only whether it is already asked varies. */
function tellAction(
  kind: string,
  t: T,
  context: PeekActionContext
): PeekAction[] {
  const askable = askableKind(kind);
  if (!askable) return [];
  if (context.watching) {
    return [{ id: "tell", label: t("tell", "stopAsking"), icon: BellOff }];
  }
  const label =
    askable === "Pod"
      ? t("tell", "askPod")
      : askable === "Job"
        ? t("tell", "askJob")
        : t("tell", "askRollout");
  return [{ id: "tell", label, icon: Bell }];
}

/* ---------- Scale ---------- */

type ScaleCommand = (
  name: string,
  replicas: number,
  namespace: string | null
) => Promise<unknown>;

/**
 * The kinds whose replica count this app sets, and the only list that says so.
 *
 * Both surfaces read it — the peek's action row and its dialog — so a kind
 * cannot end up with a button on one and nothing on the other.
 *
 * ReplicaSet is deliberately absent. It is scalable through the API, but a
 * count set on one under a Deployment is undone by the Deployment controller
 * on the same watch event — the dialog's "this lasts until the next pass" has
 * no honest form for a number that never lands. An orphaned ReplicaSet would
 * keep it, but offering the control only for the rare unowned one means a
 * Scale that appears and disappears between two revisions of one Deployment.
 * The page links the owning Deployment instead, which is where the count is
 * really set.
 */
const SCALE_COMMANDS: Record<ScalableKind, ScaleCommand> = {
  Deployment: (name, replicas, namespace) =>
    commands.scaleDeployment(name, replicas, namespace),
  StatefulSet: (name, replicas, namespace) =>
    commands.scaleStatefulset(name, replicas, namespace),
};

export function scaleCommandFor(kind: string): ScaleCommand | null {
  return isScalable(kind) ? SCALE_COMMANDS[kind] : null;
}

function scaleAction(kind: ResourceKind, t: T): PeekAction[] {
  if (!isScalable(kind)) return [];
  return [{ id: "scale", label: t("action", "scale"), icon: Scale }];
}

/* ---------- Pod ---------- */

const FINISHED_PHASES = new Set(["succeeded", "completed"]);

/**
 * The container a shell or a forward would reach.
 *
 * `shellTargets` decides both what counts and what comes first — app
 * container, then sidecar, then a running init container. On a meshed pod
 * whose app container has not come up, the sidecar is a real shell.
 */
export function reachableContainer(pod: PodInfo | undefined) {
  if (!pod) return undefined;
  return shellTargets(pod)[0];
}

/** "app is waiting · ImagePullBackOff", when the API says that much. */
function waitingNote(pod: PodInfo, t: T): string {
  // Init containers included: a pod held at `Init:ImagePullBackOff` has
  // app containers that all read `PodInitializing`, and the one container
  // that knows what is wrong is in the other list.
  const waiting = podContainers(pod).find(
    (container) => container.state.type === "waiting"
  );
  if (!waiting || waiting.state.type !== "waiting") return "";
  return waiting.state.reason
    ? t("action", "waitingNote", {
        container: waiting.name,
        reason: waiting.state.reason,
      })
    : "";
}

function podActions(pod: PodInfo | undefined, t: T): PeekAction[] {
  const phase = pod?.status.phase ?? "";
  // The gates read the phase; the sentences name the status the badge
  // shows, or "this pod is Running" sits under an Error badge.
  const shown = pod?.status.display ?? phase;
  const lower = phase.toLowerCase();
  const finished = FINISHED_PHASES.has(lower);
  const failed = lower === "failed";
  const live = !!reachableContainer(pod);

  let shellReason: string | undefined;
  if (finished) {
    shellReason = t("action", "podFinishedNoShell", { phase: shown });
  } else if (failed) {
    shellReason = t("action", "podStoppedNoShell");
  } else if (pod && !live) {
    shellReason = t("action", "noContainerRunningYet", {
      phase: shown,
      note: waitingNote(pod, t),
    });
  }

  const declaresPorts = !!pod && podPorts(pod).length > 0;
  let forwardReason: string | undefined;
  if (pod && !declaresPorts) {
    forwardReason = t("action", "podDeclaresNoPort");
  } else if (pod && !live) {
    forwardReason = t("action", "nothingListeningYet", {
      phase: shown,
      note: waitingNote(pod, t),
    });
  }

  return [
    {
      id: "shell",
      label: t("action", "shell"),
      icon: Terminal,
      reason: shellReason,
    },
    {
      id: "portForward",
      label: t("action", "portForward"),
      icon: Network,
      reason: forwardReason,
    },
    { id: "debug", label: t("action", "debug"), icon: Bug },
    podRestartAction(pod, t),
    ...deleteAction("Pod", t),
  ];
}

/**
 * Restarting a pod is deleting it. With an owner above, that is a
 * replacement and reads as a restart; with none the pod simply stops
 * existing, and calling that "Restart" would be a lie told in one word.
 * Owners not read yet (a list row) are not "no owner".
 */
export function podRestartAction(pod: PodInfo | undefined, t: T): PeekAction {
  const bare =
    Array.isArray(pod?.ownerReferences) && pod.ownerReferences.length === 0;
  return bare
    ? {
        id: "restart",
        label: t("action", "restartDeletesIt"),
        icon: RefreshCw,
        danger: true,
      }
    : { id: "restart", label: t("action", "restart"), icon: RefreshCw };
}

/* ---------- Service ---------- */

function serviceForwardAction(
  service: ServiceInfo | undefined,
  t: T,
  context: PeekActionContext
): PeekAction {
  const action: PeekAction = {
    id: "portForward",
    label: t("action", "portForward"),
    icon: Network,
  };
  if (!service) return action;
  if (service.ports.length === 0) {
    return {
      ...action,
      reason: t("action", "serviceDeclaresNoPorts"),
    };
  }
  if (context.backendError) {
    return {
      ...action,
      reason: t("action", "endpointsUnreadable", {
        error: context.backendError,
      }),
    };
  }
  // Still looking: the row shows it busy rather than guessing either way.
  if (context.backendPending || context.backend === undefined) return action;
  if (!context.backend) {
    return {
      ...action,
      reason: t("action", "noReadyEndpoints"),
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
  NetworkPolicy: (name, namespace) =>
    commands.deleteNetworkPolicy(name, namespace),
  Gateway: (name, namespace) => commands.deleteGateway(name, namespace),
  GatewayClass: (name) => commands.deleteGatewayClass(name),
  // The five route kinds share one command and tell it which they are.
  HTTPRoute: (name, namespace) =>
    commands.deleteGatewayRoute("HTTPRoute", name, namespace),
  GRPCRoute: (name, namespace) =>
    commands.deleteGatewayRoute("GRPCRoute", name, namespace),
  TLSRoute: (name, namespace) =>
    commands.deleteGatewayRoute("TLSRoute", name, namespace),
  TCPRoute: (name, namespace) =>
    commands.deleteGatewayRoute("TCPRoute", name, namespace),
  UDPRoute: (name, namespace) =>
    commands.deleteGatewayRoute("UDPRoute", name, namespace),
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

/**
 * Rolling a workload is not one command, and the kind decides which. A kind
 * offered Restart with no entry here used to fall through to `restartPod`,
 * which for anything but a pod is a delete — the same word for the opposite
 * outcome. So the offer and the command come from this one table.
 */
type RestartCommand = (name: string, namespace: string | null) => Promise<void>;

const RESTART_COMMANDS: Partial<Record<ResourceKind, RestartCommand>> = {
  Pod: (name, namespace) => commands.restartPod(name, namespace),
  Deployment: (name, namespace) => commands.restartDeployment(name, namespace),
  StatefulSet: (name, namespace) =>
    commands.restartStatefulset(name, namespace),
  DaemonSet: (name, namespace) => commands.restartDaemonset(name, namespace),
};

/**
 * Whether a managed restart has to ask first.
 *
 * The page's rule, in one place both surfaces can read: a dialog is owed when
 * a delivery controller would undo the restart, or when the cluster is marked
 * critical. The peek asked only the second half, so on an ordinary cluster an
 * Argo-managed StatefulSet restarted from the peek fired straight through
 * while the page for the same object asked "Argo CD will undo this Restart".
 */
export function restartNeedsAsking(
  intercepted: boolean,
  criticalActive: boolean
): boolean {
  return intercepted || criticalActive;
}

/**
 * The kinds whose restart is a rolling one, asked every time with what it
 * will do. Dana restarted `cart` from the peek by accident: Scale opened a
 * dialog and Delete asked for the name, and Restart fired on one click.
 */
export function restartRollsOut(kind: string): boolean {
  const resolved = toKind(kind);
  return (
    resolved === "Deployment" ||
    resolved === "StatefulSet" ||
    resolved === "DaemonSet"
  );
}

export function restartCommandFor(kind: string): RestartCommand | null {
  const resolved = toKind(kind);
  return (resolved && RESTART_COMMANDS[resolved]) ?? null;
}

function restartAction(kind: ResourceKind, t: T): PeekAction[] {
  if (!RESTART_COMMANDS[kind]) return [];
  return [{ id: "restart", label: t("action", "restart"), icon: RefreshCw }];
}

function deleteAction(kind: ResourceKind, t: T): PeekAction[] {
  if (!DELETE_COMMANDS[kind]) return [];
  return [
    { id: "delete", label: t("action", "delete"), icon: Trash2, danger: true },
  ];
}

/* ---------- What a confirmation has to say ---------- */

export interface PeekConfirmCopy {
  title: string;
  description: string;
}

export const qualified = (name: string, namespace: string | null) =>
  namespace ? `${namespace}/${name}` : name;

/**
 * The confirmation's own sentence, and what delivery adds to it.
 *
 * Prepended rather than replacing: "this deletes the object" is still true,
 * and "and the controller puts it straight back" is the part that changes what
 * you would do.
 */
export function warned(
  description: string,
  intercept: { lead: string; description: string } | null
): string {
  return intercept
    ? `${intercept.lead} ${intercept.description} ${description}`
    : description;
}

/**
 * "Are you sure?" asks nothing. Naming the object and what goes with it is
 * the only wording that lets a reader catch the wrong row before typing.
 */
export function describeDeletion(
  kind: string,
  name: string,
  namespace: string | null,
  detail: unknown,
  t: T
): PeekConfirmCopy {
  const resolved = toKind(kind) ?? kind;
  // The kind stays as Kubernetes spells it — see the kind-names trap in
  // `src/ui/i18n/`. Only the sentence around it is translated.
  const subject = `${resolved} ${qualified(name, namespace)}`;
  return {
    title: t("action", "deleteSubjectTitle", { subject }),
    description: t("action", "deleteSubjectBody", {
      subject,
      effect: deletionEffect(resolved, detail, t),
    }),
  };
}

/**
 * What a delete does beyond what the cascade preview counts, read from the
 * object: never a sentence the preview beside it can contradict.
 */
function deletionEffect(kind: string, detail: unknown, t: T): string {
  switch (kind) {
    case "Pod":
      return podDeletionEffect(detail as PodInfo | undefined, t);
    case "Deployment":
      return t("action", "effectDeployment");
    case "StatefulSet": {
      const set = detail as StatefulSetDetailInfo | undefined;
      if (!set?.claimTemplates) return t("action", "effectStatefulSetUnread");
      if (set.claimTemplates.length === 0)
        return t("action", "effectStatefulSet");
      const templates = set.claimTemplates.join(", ");
      return set.claimsWhenDeleted === "Delete"
        ? t("action", "effectStatefulSetClaimsGo", { templates })
        : t("action", "effectStatefulSetClaimsStay", { templates });
    }
    case "DaemonSet":
      return t("action", "effectDaemonSet");
    case "Job":
      return t("action", "effectJob");
    case "CronJob":
      return t("action", "effectCronJob");
    case "Service":
      return t("action", "effectService");
    case "ConfigMap":
    case "Secret":
      return t("action", "effectConfigLike");
    case "PersistentVolumeClaim":
      return t("action", "effectClaim");
    case "PersistentVolume":
      return t("action", "effectVolume");
    case "CustomResourceDefinition":
      return t("action", "effectCrd");
    default:
      return t("action", "effectPermanent");
  }
}

function podDeletionEffect(pod: PodInfo | undefined, t: T): string {
  if (!Array.isArray(pod?.ownerReferences))
    return t("action", "effectPodUnread");
  const owners = pod.ownerReferences;
  const controller = owners.find((owner) => owner.controller);
  if (!controller) {
    const [owner] = owners;
    return owner
      ? t("action", "effectPodUncontrolled", {
          kind: owner.kind,
          name: owner.name,
        })
      : t("action", "effectPodBare");
  }
  const phase = pod?.status.phase.toLowerCase() ?? "";
  if (
    controller.kind === "Job" &&
    (FINISHED_PHASES.has(phase) || phase === "failed")
  )
    return t("action", "effectPodFinished", { name: controller.name });
  return t("action", "effectPodOwned", {
    kind: controller.kind,
    name: controller.name,
  });
}

/**
 * A pod's restart is its deletion, so it asks with the delete's own facts:
 * what replaces the pod, or that nothing does.
 */
export function describePodRestart(
  name: string,
  namespace: string | null,
  detail: unknown,
  t: T
): PeekConfirmCopy {
  const pod = qualified(name, namespace);
  return {
    title: t("action", "restartSubjectTitle", {
      subject: t("action", "podSubject", { name: pod }),
    }),
    description: t("action", "restartPodBody", {
      name: pod,
      effect: podDeletionEffect(detail as PodInfo | undefined, t),
    }),
  };
}

/**
 * What a mutation from the panel has to make stale.
 *
 * The panel is not modal: the list it was opened from is still on screen
 * behind it, so a row keeping its old state after a delete is the first thing
 * anyone notices. Both key shapes are covered — the lists are plural-first,
 * the objects singular-first, and the panel's Overview is the object's own
 * entry — plus what the panel reads besides.
 */
export function peekMutationKeys(kind: string): string[][] {
  const resolved = toKind(kind) ?? kind;
  return [
    queryKeys.lists(resolved as ResourceKind),
    queryKeys.details(resolved),
    // Every mutation the panel offers ends in pods changing, and the pod list
    // is the one most likely to be the view behind it.
    queryKeys.lists(ResourceType.Pod),
    queryKeys.everyPodRows(),
    queryKeys.details(ResourceType.Pod),
    queryKeys.everyOwnedPods(),
    queryKeys.everyManifest(),
    ["peek"],
    ["peek-jobs"],
    ["peek-events"],
  ];
}
