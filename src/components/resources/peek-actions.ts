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
import {
  isScalable,
  toKind,
  toPlural,
  type ResourceKind,
  type ScalableKind,
} from "@/lib/resource-registry";
import type { DeploymentInfo, PodInfo, ServiceInfo } from "@/generated/types";
import type { T } from "@/i18n/useT";

/**
 * What the peek panel lets you *do* to the object it is showing.
 *
 * The split from the panel is deliberate: which actions a kind has, and why
 * one of them cannot run right now, is a question about Kubernetes, not about
 * React. It answers here, in one place, testable without a DOM — the panel
 * only has to render the answer and own the dialogs.
 *
 * Nothing here pre-flights access, and that is still true now that the nav
 * does. A `SelfSubjectAccessReview` decides how a nav row is *drawn* — the
 * reader has not committed to anything yet, and a wrong mark costs them a
 * mark the real call then corrects. A button is the commitment: greying it
 * out on a guess shuts somebody out of an action they could have taken, and
 * a review that disagrees with the call does so in exactly the cases that
 * matter. So an RBAC refusal surfaces here the way it does on every detail
 * page: the call is made, it fails, and the error says so.
 */

export type PeekActionId =
  "shell" | "debug" | "portForward" | "restart" | "scale" | "delete";

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
  t: T,
  context: PeekActionContext = {}
): PeekActionPlan {
  const resolved = toKind(kind);
  const actions = resolved ? actionsFor(resolved, detail, t, context) : [];

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
  t: T,
  context: PeekActionContext
): PeekAction[] {
  switch (kind) {
    case "Pod":
      return podActions(detail as PodInfo | undefined, t);
    case "Deployment":
      return [
        ...scaleAction(kind),
        { id: "restart", label: "Restart", icon: RefreshCw },
        ...deleteAction(kind),
      ];
    case "Node":
      // The node page offers exactly one thing; cordon and drain exist in the
      // backend but have never had a control, and the peek is not the place
      // to introduce one.
      return [{ id: "debug", label: t("action", "debugNode"), icon: Bug }];
    case "Service":
      return [
        serviceForwardAction(detail as ServiceInfo | undefined, t, context),
        ...deleteAction(kind),
      ];
    default:
      return [...scaleAction(kind), ...deleteAction(kind)];
  }
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
 * **ReplicaSet is deliberately absent.** It is scalable through the API, and
 * setting the count on one under a Deployment is undone by the Deployment
 * controller on the same watch event, not in fifteen seconds — there is no
 * honest version of the dialog's "this lasts until the next pass" for a number
 * that never lands at all. An orphaned ReplicaSet would keep the count, but
 * offering the control only for the rare unowned one would mean a Scale that
 * appears and disappears between two revisions of the same Deployment. The
 * page instead links the Deployment that owns it, which is where the count is
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

function scaleAction(kind: ResourceKind): PeekAction[] {
  if (!isScalable(kind)) return [];
  return [{ id: "scale", label: "Scale", icon: Scale }];
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
  const owned = !!pod?.ownerReferences?.length;

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
    // Restarting a pod is deleting it. With a controller above, that is a
    // replacement and reads as a restart; without one the pod simply stops
    // existing, and calling that "Restart" would be a lie told in one word.
    owned || !pod
      ? { id: "restart", label: t("action", "restart"), icon: RefreshCw }
      : {
          id: "restart",
          label: t("action", "restartDeletesIt"),
          icon: RefreshCw,
          danger: true,
        },
    ...deleteAction("Pod"),
  ];
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
  detail: unknown,
  t: T
): PeekConfirmCopy {
  const resolved = toKind(kind) ?? kind;
  // The kind stays as Kubernetes spells it — see the kind-names trap in
  // `src/i18n/`. Only the sentence around it is translated.
  const subject = `${resolved.toLowerCase()} ${qualified(name, namespace)}`;
  return {
    title: t("action", "deleteSubjectTitle", { subject }),
    description: t("action", "deleteSubjectBody", {
      subject,
      effect: deletionEffect(resolved, detail, t),
    }),
  };
}

function deletionEffect(kind: string, detail: unknown, t: T): string {
  switch (kind) {
    case "Pod": {
      const owner = (detail as PodInfo | undefined)?.ownerReferences?.[0];
      return owner
        ? t("action", "effectPodOwned", {
            kind: owner.kind,
            name: owner.name,
          })
        : t("action", "effectPodBare");
    }
    case "Deployment": {
      const desired = (detail as DeploymentInfo | undefined)?.replicas.desired;
      return desired
        ? t("count", "effectDeploymentPods", { n: desired })
        : t("action", "effectWorkloadPods");
    }
    case "StatefulSet":
      return t("action", "effectStatefulSet");
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
    default:
      return t("action", "effectPermanent");
  }
}

/**
 * The confirmation a bare pod's restart needs. Owned pods get none: the
 * controller replaces them and the panel stays honest by doing it silently.
 */
export function describeBareRestart(
  name: string,
  namespace: string | null,
  t: T
): PeekConfirmCopy {
  const subject = t("action", "podSubject", {
    name: qualified(name, namespace),
  });
  return {
    title: t("action", "restartSubjectTitle", { subject }),
    description: t("action", "restartBareBody", { subject }),
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
