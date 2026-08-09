/**
 * What a managed cluster already says about its own nodes.
 *
 * On GKE, EKS or AKS every node is labelled with the pool it belongs to, the
 * machine it runs on, the zone it sits in and whether it is disposable. The
 * app has carried those labels across the wire since the beginning and read
 * none of them, so a forty-node cluster drew forty flat rows and the reader
 * could not see that they were three pools of different machines in different
 * places, half of them reclaimable at an hour's notice.
 *
 * Three vendors spelling four facts differently is a table, not an
 * architecture — hence a handful of arrays and no provider interface.
 *
 * The hard rule is that **absence is not a claim**. No recognised label means
 * "not a managed cluster we recognise", which is not "not managed" and is
 * certainly not "not spot": a cluster may be OpenStack, Hetzner, bare metal or
 * something nobody here has heard of. So every field is nullable, `spot` is
 * only ever set by a label that says so, and the one fact that names a cloud
 * outright — `spec.providerID`'s scheme — is never substituted for by a pool
 * label that merely hints at one.
 */

import type { NodeInfo } from "@/generated/types";

/**
 * The pool a node belongs to. First hit wins; a node carries at most one of
 * these in practice, and a Karpenter node on EKS carries the Karpenter one
 * rather than the managed-node-group one because it is not in a node group.
 */
const POOL_KEYS = [
  "cloud.google.com/gke-nodepool",
  "eks.amazonaws.com/nodegroup",
  "karpenter.sh/nodepool",
  // Karpenter's pre-v1beta1 spelling, still worn by a cluster on v1alpha5.
  "karpenter.sh/provisioner-name",
  "kubernetes.azure.com/agentpool",
] as const;
// AKS's deprecated unprefixed `agentpool` is deliberately not in that list:
// every AKS node also carries the prefixed one, so it would add nothing here
// while making any cluster where somebody typed `agentpool` by hand look
// managed.

/**
 * Label, and the value of it that means "the cloud may take this back".
 *
 * Values are compared case-insensitively because the vendors disagree with
 * each other about case for the same word — EKS writes `SPOT`, Karpenter and
 * AKS write `spot` — and a comparison that gets that wrong silently reports
 * a spot pool as an ordinary one.
 *
 * Only "yes" is listed. `capacityType=ON_DEMAND`, `capacity-type=reserved` and
 * `priority=regular` all exist and none of them is read, because nothing in
 * the app ever states that a node is *not* spot and so nothing needs them.
 */
const SPOT_LABELS: ReadonlyArray<readonly [key: string, value: string]> = [
  ["cloud.google.com/gke-spot", "true"],
  // Preemptible predates Spot on GKE and is still what an older pool wears.
  ["cloud.google.com/gke-preemptible", "true"],
  // The label that replaced both of the above from GKE 1.25.5-gke.2500.
  ["cloud.google.com/gke-provisioning", "spot"],
  ["cloud.google.com/gke-provisioning", "preemptible"],
  ["eks.amazonaws.com/capacityType", "spot"],
  // Not an EKS label, and the common case on an EKS cluster all the same.
  ["karpenter.sh/capacity-type", "spot"],
  ["kubernetes.azure.com/priority", "spot"],
  // AKS deprecated this one in favour of `priority`; older nodes wear it.
  ["kubernetes.azure.com/scalesetpriority", "spot"],
];

/** The beta spellings are what a cluster older than 1.17 still writes. */
const MACHINE_KEYS = [
  "node.kubernetes.io/instance-type",
  "beta.kubernetes.io/instance-type",
] as const;

const ZONE_KEYS = [
  "topology.kubernetes.io/zone",
  "failure-domain.beta.kubernetes.io/zone",
] as const;

const REGION_KEYS = [
  "topology.kubernetes.io/region",
  "failure-domain.beta.kubernetes.io/region",
] as const;

/**
 * `spec.providerID`'s scheme, and the cloud that writes it. This is the only
 * unambiguous statement of which cloud a node is on: a pool label is weaker
 * evidence, because anyone may apply one by hand.
 *
 * A scheme that is not in here is left unnamed rather than guessed at — and
 * plenty of clusters have one, k3s and RKE2 included, which is exactly why an
 * unrecognised `providerID` is not on its own enough to open a section.
 */
const CLOUD_BY_SCHEME: Readonly<Record<string, string>> = {
  gce: "Google Cloud",
  aws: "AWS",
  azure: "Azure",
};

function firstLabel(
  labels: Record<string, string>,
  keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = labels[key];
    if (value) return value;
  }
  return null;
}

export interface NodePlacement {
  /** The node pool, node group or agent pool this node was made by. */
  pool: string | null;
  /** The machine it runs on, e.g. `e2-standard-4`, `m5.large`. */
  machine: string | null;
  zone: string | null;
  region: string | null;
  /**
   * A recognised label states this node is spot or preemptible. `false` means
   * nothing said so — never "this node is not spot".
   */
  spot: boolean;
  /** Named only from `providerID`'s scheme, and null for any other scheme. */
  cloud: string | null;
  providerId: string | null;
}

export function nodePlacement(node: NodeInfo): NodePlacement {
  const labels = node.labels ?? {};
  const providerId = node.providerId || null;
  const scheme = providerId?.split("://")[0]?.toLowerCase() ?? null;

  return {
    pool: firstLabel(labels, POOL_KEYS),
    machine: firstLabel(labels, MACHINE_KEYS),
    zone: firstLabel(labels, ZONE_KEYS),
    region: firstLabel(labels, REGION_KEYS),
    spot: SPOT_LABELS.some(
      ([key, value]) => labels[key]?.toLowerCase() === value
    ),
    cloud: scheme ? (CLOUD_BY_SCHEME[scheme] ?? null) : null,
    providerId,
  };
}

/**
 * Whether this node said anything at all worth a section of its own. A k3d,
 * kind or minikube node says none of it, and gets exactly the page it got
 * before this existed.
 *
 * A `providerID` alone does not count, and that is the whole reason this
 * function exists rather than a null check at each call site: k3s writes
 * `k3s://<node-name>`, so every k3d node in the world has one, and a section
 * holding one row that repeats the node's own name in a URL is worse than no
 * section. It has to be a fact somebody could act on — a pool, a machine, a
 * place, or a cloud whose scheme we actually recognise.
 */
export function statesPlacement(placement: NodePlacement): boolean {
  return (
    placement.pool !== null ||
    placement.machine !== null ||
    placement.zone !== null ||
    placement.region !== null ||
    placement.spot ||
    placement.cloud !== null
  );
}

/** The pool a node's row is grouped under, or null when nothing says. */
export function poolOf(node: NodeInfo): string | null {
  return firstLabel(node.labels ?? {}, POOL_KEYS);
}

export interface PoolFacts {
  nodes: number;
  /** Distinct, in first-seen order. A pool may hold more than one. */
  machines: string[];
  zones: string[];
  /** How many of the pool's nodes a label calls spot. */
  spotNodes: number;
}

function distinct(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

export function poolFacts(nodes: readonly NodeInfo[]): PoolFacts {
  const placements = nodes.map(nodePlacement);
  return {
    nodes: nodes.length,
    machines: distinct(placements.map((p) => p.machine)),
    zones: distinct(placements.map((p) => p.zone)),
    spotNodes: placements.filter((p) => p.spot).length,
  };
}

/**
 * `europe-west1-b, europe-west1-c` is one string written twice with a letter
 * changed, and it is the common case: a pool spanning zones spans zones of the
 * same region. Only the first zone's prefix up to and including its last `-`
 * is elided, and only when every zone in the list carries it — so two regions
 * in one pool stay written out in full rather than collapsing into a line that
 * hides which region is which.
 */
export function elideZonePrefix(zones: readonly string[]): string[] {
  if (zones.length < 2) return [...zones];
  const cut = zones[0].lastIndexOf("-");
  if (cut <= 0) return [...zones];
  const prefix = zones[0].slice(0, cut + 1);
  if (!zones.every((zone) => zone.startsWith(prefix) && zone !== prefix)) {
    return [...zones];
  }
  return zones.map((zone, index) =>
    index === 0 ? zone : `-${zone.slice(prefix.length)}`
  );
}

/**
 * A facet the pool's nodes may disagree about, said in the width of a caption.
 *
 * Naming the values is always better than counting them, right up until the
 * point where the caption becomes a list — a Karpenter pool legitimately spans
 * a dozen instance types, and twelve of them in a header is a wall, not a
 * fact. Three is where it turns.
 */
const NAME_LIMIT = 3;

function listOrCount(values: readonly string[], plural: string): string | null {
  if (values.length === 0) return null;
  if (values.length <= NAME_LIMIT) return values.join(", ");
  return `${values.length} ${plural}`;
}

/**
 * The dim half of a pool's caption: what these machines are, where they are,
 * and how many. Each facet is dropped rather than stubbed when the cluster
 * does not state it, so a pool that only names itself says `4 nodes` and does
 * not carry two empty separators.
 *
 * The count is deliberately bare. `3 of max 3` needs a cloud credential to
 * know the maximum, and inventing one from the nodes that happen to exist
 * would be a number the reader would act on and that nothing checked.
 */
export function describePool(facts: PoolFacts): string {
  const parts = [
    listOrCount(facts.machines, "machine types"),
    listOrCount(elideZonePrefix(facts.zones), "zones"),
    `${facts.nodes} ${facts.nodes === 1 ? "node" : "nodes"}`,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/**
 * What the spot mark on a pool header reads, or null when nothing in the pool
 * says spot.
 *
 * A GKE or AKS pool is uniformly spot, so the mark is one word. A Karpenter
 * pool may genuinely mix, and there the count is the fact — a pool where two
 * of five nodes can vanish is not the same arrangement as one where all five
 * can, and calling either of them just "spot" would be picking one node's
 * truth and calling it the pool's.
 */
export function spotMark(facts: PoolFacts): string | null {
  if (facts.spotNodes === 0) return null;
  if (facts.spotNodes === facts.nodes) return "spot";
  return `${facts.spotNodes} of ${facts.nodes} spot`;
}
