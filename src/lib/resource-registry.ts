import {
  Box,
  Boxes,
  Layers,
  Database,
  Server,
  Copy,
  Briefcase,
  CalendarClock,
  FileText,
  KeyRound,
  Network,
  Globe,
  HardDrive,
  HardDriveDownload,
  Activity,
  FolderOpen,
  Puzzle,
  Gauge,
  ShieldCheck,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

export type ResourceScope = "namespaced" | "cluster";
export type ResourceCategory =
  "workloads" | "network" | "storage" | "configuration" | null;

export const RESOURCE_REGISTRY = [
  {
    kind: "Pod",
    plural: "pods",
    displayPlural: "Pods",
    icon: Box,
    apiVersion: "v1",
    scope: "namespaced",
    category: "workloads",
  },
  {
    kind: "Deployment",
    plural: "deployments",
    displayPlural: "Deployments",
    icon: Layers,
    apiVersion: "apps/v1",
    scope: "namespaced",
    category: "workloads",
  },
  {
    kind: "ReplicaSet",
    plural: "replicasets",
    displayPlural: "ReplicaSets",
    // Not `Copy`, which is the DaemonSet's "one per node": the grouped boxes
    // are the Pod's own cube repeated, which is what a ReplicaSet is.
    //
    // The plural here is never a nav row — nothing lists ReplicaSets. It is
    // read by `getResourceDetailUrl` and by the peek's URL, both of which
    // need the path segment `App.tsx` serves the detail route on.
    icon: Boxes,
    apiVersion: "apps/v1",
    scope: "namespaced",
    category: "workloads",
  },
  {
    kind: "StatefulSet",
    plural: "statefulsets",
    displayPlural: "StatefulSets",
    icon: Database,
    apiVersion: "apps/v1",
    scope: "namespaced",
    category: "workloads",
  },
  {
    kind: "DaemonSet",
    plural: "daemonsets",
    displayPlural: "DaemonSets",
    // Not Server, which belongs to Nodes: a DaemonSet and a Node drawn with
    // the same mark sit six rows apart in the sidebar and stop being two
    // things. The offset-frames glyph reads as "one copy per node".
    icon: Copy,
    apiVersion: "apps/v1",
    scope: "namespaced",
    category: "workloads",
  },
  {
    kind: "Job",
    plural: "jobs",
    displayPlural: "Jobs",
    icon: Briefcase,
    apiVersion: "batch/v1",
    scope: "namespaced",
    category: "workloads",
  },
  {
    kind: "CronJob",
    plural: "cronjobs",
    displayPlural: "CronJobs",
    icon: CalendarClock,
    apiVersion: "batch/v1",
    scope: "namespaced",
    category: "workloads",
  },
  {
    kind: "ConfigMap",
    plural: "configmaps",
    displayPlural: "ConfigMaps",
    icon: FileText,
    apiVersion: "v1",
    scope: "namespaced",
    category: "configuration",
  },
  {
    kind: "Secret",
    plural: "secrets",
    displayPlural: "Secrets",
    icon: KeyRound,
    apiVersion: "v1",
    scope: "namespaced",
    category: "configuration",
  },
  {
    kind: "Service",
    plural: "services",
    displayPlural: "Services",
    icon: Network,
    apiVersion: "v1",
    scope: "namespaced",
    category: "network",
  },
  {
    kind: "Ingress",
    plural: "ingresses",
    displayPlural: "Ingresses",
    icon: Globe,
    apiVersion: "networking.k8s.io/v1",
    scope: "namespaced",
    category: "network",
  },
  {
    kind: "PersistentVolumeClaim",
    plural: "persistentvolumeclaims",
    displayPlural: "PVCs",
    // A claim draws from a volume, so it is the drive with the arrow — the
    // two sat adjacent under Storage sharing one mark.
    icon: HardDriveDownload,
    apiVersion: "v1",
    scope: "namespaced",
    category: "storage",
  },
  {
    kind: "PersistentVolume",
    plural: "persistentvolumes",
    displayPlural: "Persistent Volumes",
    icon: HardDrive,
    apiVersion: "v1",
    scope: "cluster",
    category: "storage",
  },
  {
    kind: "StorageClass",
    plural: "storageclasses",
    displayPlural: "Storage Classes",
    icon: Database,
    apiVersion: "storage.k8s.io/v1",
    scope: "cluster",
    category: "storage",
  },
  {
    kind: "Endpoints",
    plural: "endpoints",
    displayPlural: "Endpoints",
    // Not Service's mark, which it shared until both were in the nav at
    // once: two rows drawn with one glyph stop being two things.
    icon: Waypoints,
    apiVersion: "v1",
    scope: "namespaced",
    category: "network",
  },
  {
    kind: "Node",
    plural: "nodes",
    displayPlural: "Nodes",
    icon: Server,
    apiVersion: "v1",
    scope: "cluster",
    category: null,
  },
  {
    kind: "Event",
    plural: "events",
    displayPlural: "Events",
    icon: Activity,
    apiVersion: "v1",
    scope: "namespaced",
    category: null,
  },
  {
    kind: "Namespace",
    plural: "namespaces",
    displayPlural: "Namespaces",
    icon: FolderOpen,
    apiVersion: "v1",
    scope: "cluster",
    category: null,
  },
  {
    // Registered for the glyph and for nothing else. Neither of the two
    // governing kinds gets a nav row or a page: an autoscaler is a property
    // of the thing it scales and a budget a property of the pods it
    // protects, so both are read where that thing is. What they do need is a
    // mark, because they appear by name in Connections and on the workload,
    // and `CircleDashed` is the app saying "I do not know this kind".
    kind: "HorizontalPodAutoscaler",
    plural: "horizontalpodautoscalers",
    displayPlural: "HorizontalPodAutoscalers",
    icon: Gauge,
    apiVersion: "autoscaling/v2",
    scope: "namespaced",
    category: null,
  },
  {
    kind: "PodDisruptionBudget",
    plural: "poddisruptionbudgets",
    displayPlural: "PodDisruptionBudgets",
    icon: ShieldCheck,
    apiVersion: "policy/v1",
    scope: "namespaced",
    category: null,
  },
  {
    kind: "CustomResourceDefinition",
    plural: "customresourcedefinitions",
    displayPlural: "CRDs",
    icon: Puzzle,
    apiVersion: "apiextensions.k8s.io/v1",
    scope: "cluster",
    category: null,
  },
] as const;

export type ResourceKind = (typeof RESOURCE_REGISTRY)[number]["kind"];
export type ResourceDefinition = (typeof RESOURCE_REGISTRY)[number];

export const ResourceType = Object.fromEntries(
  RESOURCE_REGISTRY.map((entry) => [entry.kind, entry.kind])
) as { [K in ResourceKind]: K };

const RESOURCE_BY_KIND = new Map<ResourceKind, ResourceDefinition>(
  RESOURCE_REGISTRY.map((entry) => [entry.kind, entry])
);
const RESOURCE_BY_PLURAL = new Map<string, ResourceDefinition>(
  RESOURCE_REGISTRY.map((entry) => [entry.plural, entry])
);

export function toPlural(resourceKind: ResourceKind): string {
  return (
    RESOURCE_BY_KIND.get(resourceKind)?.plural ?? resourceKind.toLowerCase()
  );
}

export function toKind(resourceType: string): ResourceKind | null {
  if (RESOURCE_BY_KIND.has(resourceType as ResourceKind)) {
    return resourceType as ResourceKind;
  }
  const lower = resourceType.toLowerCase();
  return RESOURCE_BY_PLURAL.get(lower)?.kind ?? null;
}

/**
 * The kinds whose replica count a reader can set by hand, everywhere.
 *
 * One list, because the trap is a control that exists on the detail page and
 * not in the peek, or a chain that points at an owner with no way to change
 * the number when you get there. The Scale command table is keyed by this
 * type, so adding a kind here does not compile until its command exists.
 *
 * DaemonSet is absent because it has no replica count — one pod per matching
 * node is the whole model. ReplicaSet is absent on purpose: see the note on
 * `SCALE_COMMANDS`.
 */
export const SCALABLE_KINDS = ["Deployment", "StatefulSet"] as const;
export type ScalableKind = (typeof SCALABLE_KINDS)[number];

export function isScalable(kind: string): kind is ScalableKind {
  const resolved = toKind(kind);
  return (
    resolved !== null &&
    (SCALABLE_KINDS as readonly string[]).includes(resolved)
  );
}

export function isResourceType(value: string): value is ResourceKind {
  return (
    RESOURCE_BY_KIND.has(value as ResourceKind) ||
    RESOURCE_BY_PLURAL.has(value.toLowerCase())
  );
}

export function getResourceDefinition(kind: ResourceKind): ResourceDefinition {
  return RESOURCE_BY_KIND.get(kind)!;
}

export function getApiVersion(resourceKind: string): string {
  const known =
    RESOURCE_BY_KIND.get(resourceKind as ResourceKind) ??
    RESOURCE_BY_PLURAL.get(resourceKind.toLowerCase());
  return known?.apiVersion ?? "v1";
}

export function getDisplayPlural(resourceTypeOrPlural: string): string {
  const def =
    RESOURCE_BY_KIND.get(resourceTypeOrPlural as ResourceKind) ??
    RESOURCE_BY_PLURAL.get(resourceTypeOrPlural.toLowerCase());
  return def?.displayPlural ?? resourceTypeOrPlural;
}

export function getResourceIcon(kind: ResourceKind | string): LucideIcon {
  const def =
    RESOURCE_BY_KIND.get(kind as ResourceKind) ??
    RESOURCE_BY_PLURAL.get(kind.toLowerCase());
  return def?.icon ?? Box;
}

/**
 * Get the URL for a resource list page (respects category structure)
 * @example getResourceListUrl("Pod") // "/workloads/pods"
 * @example getResourceListUrl("pods") // "/workloads/pods"
 * @example getResourceListUrl("Node") // "/nodes"
 */
export function getResourceListUrl(resourceKindOrPlural: string): string {
  const def =
    RESOURCE_BY_KIND.get(resourceKindOrPlural as ResourceKind) ??
    RESOURCE_BY_PLURAL.get(resourceKindOrPlural.toLowerCase());

  if (!def) {
    return `/${resourceKindOrPlural.toLowerCase()}`;
  }

  if (def.category) {
    return `/${def.category}/${def.plural}`;
  }
  return `/${def.plural}`;
}
