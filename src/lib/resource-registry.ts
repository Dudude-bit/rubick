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
  type LucideIcon,
} from "lucide-react";

export type ResourceScope = "namespaced" | "cluster";
export type ResourceCategory =
  | "workloads"
  | "network"
  | "storage"
  | "configuration"
  | null;

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
    icon: Network,
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

export function getScope(resourceKind: ResourceKind): ResourceScope {
  return RESOURCE_BY_KIND.get(resourceKind)?.scope ?? "namespaced";
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

export function getCategory(resourceKindOrPlural: string): ResourceCategory {
  const def =
    RESOURCE_BY_KIND.get(resourceKindOrPlural as ResourceKind) ??
    RESOURCE_BY_PLURAL.get(resourceKindOrPlural.toLowerCase());
  return def?.category ?? null;
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
