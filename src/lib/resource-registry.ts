import {
  Box,
  Boxes,
  Braces,
  BrickWall,
  Cable,
  Layers,
  LockKeyhole,
  RadioTower,
  Route,
  Router,
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
  Shapes,
  ShieldCheck,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import kindsFile from "../../shared/kinds.json";

/** What Kubernetes says about a kind, as `shared/kinds.json` states it. */
export interface KindFacts {
  kind: string;
  /** `""` for the core group. */
  group: string;
  version: string;
  plural: string;
  scope: "namespaced" | "cluster";
}

const KIND_FACTS = new Map(
  (kindsFile.kinds as KindFacts[]).map((facts) => [facts.kind, facts])
);

/** The facts about `kind`, or `undefined` for a kind the file does not name. */
export function kindFacts(kind: string): KindFacts | undefined {
  return KIND_FACTS.get(kind);
}

const ENTRIES = [
  {
    kind: "Pod",
    displayPlural: "Pods",
    icon: Box,
    category: "workloads",
  },
  {
    kind: "Deployment",
    displayPlural: "Deployments",
    icon: Layers,
    category: "workloads",
  },
  {
    kind: "ReplicaSet",
    displayPlural: "ReplicaSets",
    // Not `Copy`, the DaemonSet's "one per node": grouped boxes are the
    // Pod's own cube repeated. The plural is never a nav row — nothing lists
    // ReplicaSets — but `getResourceDetailUrl` and the peek's URL read it for
    // the path segment `App.tsx` serves the detail route on.
    icon: Boxes,
    category: "workloads",
  },
  {
    kind: "StatefulSet",
    displayPlural: "StatefulSets",
    icon: Database,
    category: "workloads",
  },
  {
    kind: "DaemonSet",
    displayPlural: "DaemonSets",
    // Not Server, which belongs to Nodes: two kinds six sidebar rows apart
    // drawn with one mark stop being two things. Offset frames read as "one
    // copy per node".
    icon: Copy,
    category: "workloads",
  },
  {
    kind: "Job",
    displayPlural: "Jobs",
    icon: Briefcase,
    category: "workloads",
  },
  {
    kind: "CronJob",
    displayPlural: "CronJobs",
    icon: CalendarClock,
    category: "workloads",
  },
  {
    kind: "ConfigMap",
    displayPlural: "ConfigMaps",
    icon: FileText,
    category: "configuration",
  },
  {
    kind: "Secret",
    displayPlural: "Secrets",
    icon: KeyRound,
    category: "configuration",
  },
  {
    kind: "Service",
    displayPlural: "Services",
    icon: Network,
    category: "network",
  },
  {
    kind: "Ingress",
    displayPlural: "Ingresses",
    icon: Globe,
    category: "network",
  },
  {
    kind: "NetworkPolicy",
    displayPlural: "NetworkPolicies",
    // Not the PodDisruptionBudget's shield: both guard something, and two
    // rows in one nav with the same glyph is the nav failing at the one
    // thing it does.
    icon: BrickWall,
    category: "network",
  },
  {
    kind: "Gateway",
    displayPlural: "Gateways",
    icon: Router,
    category: "network",
  },
  {
    kind: "GatewayClass",
    displayPlural: "Gateway Classes",
    icon: Shapes,
    category: "network",
  },
  {
    kind: "HTTPRoute",
    displayPlural: "HTTPRoutes",
    icon: Route,
    category: "network",
  },
  {
    kind: "GRPCRoute",
    displayPlural: "GRPCRoutes",
    icon: Braces,
    category: "network",
  },
  {
    kind: "TLSRoute",
    displayPlural: "TLSRoutes",
    icon: LockKeyhole,
    category: "network",
  },
  {
    kind: "TCPRoute",
    displayPlural: "TCPRoutes",
    icon: Cable,
    category: "network",
  },
  {
    kind: "UDPRoute",
    displayPlural: "UDPRoutes",
    icon: RadioTower,
    category: "network",
  },
  {
    kind: "PersistentVolumeClaim",
    displayPlural: "PVCs",
    // A claim draws from a volume: the drive with the arrow, so it does not
    // share a mark with the PersistentVolume next to it under Storage.
    icon: HardDriveDownload,
    category: "storage",
  },
  {
    kind: "PersistentVolume",
    displayPlural: "Persistent Volumes",
    icon: HardDrive,
    category: "storage",
  },
  {
    kind: "StorageClass",
    displayPlural: "Storage Classes",
    icon: Database,
    category: "storage",
  },
  {
    kind: "Endpoints",
    displayPlural: "Endpoints",
    // Not Service's mark: two nav rows drawn with one glyph stop being two
    // things.
    icon: Waypoints,
    category: "network",
  },
  {
    kind: "Node",
    displayPlural: "Nodes",
    icon: Server,
    category: null,
  },
  {
    kind: "Event",
    displayPlural: "Events",
    icon: Activity,
    category: null,
  },
  {
    kind: "Namespace",
    displayPlural: "Namespaces",
    icon: FolderOpen,
    category: null,
  },
  {
    // Registered for the glyph and nothing else. Neither governing kind gets
    // a nav row or a page — an autoscaler is a property of what it scales, a
    // budget of the pods it protects, so both are read there. Both still
    // appear by name in Connections and on the workload, where an unregistered
    // kind draws as `CircleDashed`, the app's "I do not know this kind".
    kind: "HorizontalPodAutoscaler",
    displayPlural: "HorizontalPodAutoscalers",
    icon: Gauge,
    category: null,
  },
  {
    kind: "PodDisruptionBudget",
    displayPlural: "PodDisruptionBudgets",
    icon: ShieldCheck,
    category: null,
  },
  {
    kind: "CustomResourceDefinition",
    displayPlural: "CRDs",
    icon: Puzzle,
    category: null,
  },
] as const;

function withFacts<E extends (typeof ENTRIES)[number]>(entry: E) {
  const facts = KIND_FACTS.get(entry.kind);
  if (!facts)
    throw new Error(`${entry.kind} is registered and not in shared/kinds.json`);
  const { group, version, plural, scope } = facts;
  return {
    ...entry,
    group,
    version,
    plural,
    scope,
    apiVersion: group === "" ? version : `${group}/${version}`,
  };
}

export const RESOURCE_REGISTRY = ENTRIES.map(withFacts);

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

/**
 * The question that asks whether somebody may list this kind.
 *
 * Built here because this table holds every part of it — the plural the API
 * server matches, the group, and whether the kind is namespaced. A second
 * copy would be free to disagree with the URLs built from those same fields.
 */
export function listQueryFor(resourceKind: ResourceKind): {
  group: string;
  resource: string;
  namespaced: boolean;
} {
  const entry = RESOURCE_BY_KIND.get(resourceKind);
  return {
    // The API server matches the core group as the empty string.
    group: entry?.group ?? "",
    resource: toPlural(resourceKind),
    namespaced: entry?.scope !== "cluster",
  };
}

/**
 * Whether choosing one namespace narrows a read of this kind at all.
 *
 * Nodes, PersistentVolumes, StorageClasses and the other cluster-scoped
 * kinds are one list however the namespace picker is set, so offering "pick
 * one namespace" against a slow read of them sends a reader to a control
 * that cannot change the answer.
 */
export function narrowingHelps(resourceKind: ResourceKind): boolean {
  return RESOURCE_BY_KIND.get(resourceKind)?.scope !== "cluster";
}

export function toPlural(resourceKind: ResourceKind): string {
  return (
    RESOURCE_BY_KIND.get(resourceKind)?.plural ?? resourceKind.toLowerCase()
  );
}

/**
 * One of whatever the plural names, spelled the way the cluster spells it.
 *
 * Read out of the registry rather than made by trimming a letter: the API's
 * plurals are not all `noun + "s"`, and `"ingresses".replace(/s$/, "")` says
 * "1 ingresse".
 */
export function toSingularNoun(plural: string): string {
  const lower = plural.toLowerCase();
  return RESOURCE_BY_PLURAL.get(lower)?.kind.toLowerCase() ?? lower;
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
 * One list, because the trap is a control on the detail page and not in the
 * peek, or a chain pointing at an owner with no way to change the number
 * there. The Scale command table is keyed by this type, so adding a kind does
 * not compile until its command exists.
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

/**
 * The registry entry for a kind, by either spelling.
 *
 * Plurals resolve too, because `isResourceType` accepts them and narrows to
 * `ResourceKind`: the type system endorses `isResourceType(k) &&
 * getResourceDefinition(k).scope`, so a plural must not answer `undefined`
 * here against a signature that promises a definition.
 */
export function getResourceDefinition(kind: ResourceKind): ResourceDefinition {
  return (RESOURCE_BY_KIND.get(kind) ??
    RESOURCE_BY_PLURAL.get(String(kind).toLowerCase()))!;
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
