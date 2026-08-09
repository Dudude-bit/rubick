/**
 * The seam.
 *
 * A vendor contributes *facets*, not pages. Nobody opens a cert-manager page
 * — they are looking at an Ingress and want to know why its certificate has
 * not renewed. So a vendor declares what it can supply and the surface asks
 * for the facet rather than for the vendor by name. A lint rule keeps that
 * honest: nothing outside `src/integrations/` may import a vendor folder.
 *
 * ## The three tiers
 *
 * The tier decides a facet's *runtime obligations*, not where its code
 * lives:
 *
 * - **Tier 1 — free.** The cluster already says it. GKE writes
 *   `cloud.google.com/gke-nodepool` on every node whether anyone asked or
 *   not, and `NodeInfo` has carried those labels since the beginning. No
 *   account, no detection, no failure mode: {@link Vendor.nodeLabels} and
 *   {@link Vendor.flavours} are read on every cluster, always.
 * - **Tier 2 — detected.** Its whole state is CRDs on the same API server,
 *   so "is it there" has a yes or a no with nothing to fill in.
 *   {@link Vendor.crd} needs no detection call at all — a CRD group with no
 *   objects in it is never rendered — while {@link Vendor.provides} is
 *   gated on the backend's CRD scan.
 * - **Tier 3 — configured.** Needs its own address and usually a credential
 *   the kubeconfig does not carry. Nothing is tier 3 yet; Prometheus and the
 *   cloud APIs are the first candidates.
 *
 * ## What decides that something lives here
 *
 * One question, and it is not the tier: **is this knowledge about a specific
 * vendor's product?** GKE's node-pool label spellings live here even though
 * reading node labels is tier 1 and needs no account. The generic machinery
 * that groups a table by any key does not — that is the app's, and works the
 * same for a vendor nobody has heard of.
 *
 * **A capability key is a contract, and the surface must have a real answer
 * for its absence.** `certificate.issuance` absent means the page shows the
 * expiry it read from `tls.crt` itself and says nothing about renewal, which
 * is a good answer. A capability with no good answer when absent does not
 * belong behind this seam at all — which is exactly why cloud *auth* is not
 * in this tree: without it there is no kubeconfig and so no app.
 *
 * **And a vendor may never take something away.** The core answer is drawn
 * first and stays drawn; the facet extends it. A page that is worse when
 * cert-manager is absent than it was before cert-manager existed has failed
 * at the only thing this seam is for.
 *
 * Deliberately absent, because a registry of a dozen static records is a
 * list and not a framework: registration order, priorities, lifecycle hooks,
 * an event bus, third-party loading. What has to be right is the boundary.
 */

import type { ReactNode } from "react";

import type { IssuanceStory } from "@/generated/types";
import type { CrdColumn, CrdStatus } from "./kit";

/**
 * Every capability the app knows how to consume, and its contract.
 *
 * Plain async functions rather than components or hooks: the surface owns
 * how it fetches and how it draws, so the vendor cannot smuggle a layout
 * decision across the seam, and a surface can call one inside its own
 * `useQuery` without any rules-of-hooks trouble.
 */
export interface Capabilities {
  /**
   * How the certificate in a TLS Secret came to be, and what is stopping it
   * being renewed. `null` where nothing manages that Secret — a hand-made
   * certificate is a real and common answer, not a failure.
   */
  "certificate.issuance": (input: {
    namespace: string;
    secretName: string;
  }) => Promise<IssuanceStory | null>;
}

export type CapabilityKey = keyof Capabilities;

/**
 * How this vendor's own custom resources are drawn — tier 2, and its own
 * detection: an API group with no CRD behind it never reaches a list page,
 * so there is nothing to ask the cluster.
 */
export interface CrdView {
  /** Does this vendor own that API group? Kind narrows it where a group is shared. */
  matches: (group: string, kind: string) => boolean;
  /**
   * The columns for one of its kinds. Every vendor has a default for a kind
   * it does not recognise, because a CRD group grows faster than this file.
   */
  columnsFor: (kind: string) => CrdColumn[];
  status: CrdStatus;
}

/**
 * How a vendor spells the four facts a node already carries — tier 1.
 *
 * Three vendors spelling four facts differently is a table, not an
 * architecture. The generic half (`topology.kubernetes.io/zone`,
 * `node.kubernetes.io/instance-type`) is upstream Kubernetes and is not
 * here: it is the same on all of them and on clusters run by nobody.
 */
export interface NodeLabels {
  /**
   * The label naming the pool, node group or agent pool a node was made by.
   * First hit across the registry wins, so registry order is the tie-break.
   */
  pool?: readonly string[];
  /**
   * Label, and the value of it that means "the cloud may take this back".
   * Compared case-insensitively: the vendors disagree with each other about
   * case for the same word.
   */
  spot?: ReadonlyArray<readonly [key: string, value: string]>;
  /**
   * The `spec.providerID` scheme this vendor writes, and the cloud to name
   * for it. The only unambiguous statement of which cloud a node is on — a
   * pool label is weaker evidence, because anyone may apply one by hand.
   */
  providerScheme?: readonly [scheme: string, cloud: string];
}

/**
 * The flavours of Kubernetes a context name can be recognised as.
 *
 * `generic` is not a vendor and has no folder: it is what is left when no
 * vendor claims the name.
 */
export type ClusterProvider =
  | "k3d"
  | "k3s"
  | "eks"
  | "gke"
  | "aks"
  | "minikube"
  | "generic";

/**
 * What a vendor's kubeconfig context looks like, and the mark it wears —
 * tier 1, and decided before anyone configures anything, because acting on
 * the wrong cluster is the expensive mistake this tool can cause.
 */
export interface Flavour {
  id: ClusterProvider;
  /**
   * Does this context name belong to that vendor? Tested in registry order,
   * most specific vendor first, because an EKS context is an ARN that also
   * contains a region and account digits.
   *
   * `name` is already lower-cased; `hasWord` matches a marker as a whole
   * segment of a name that separates words with `-`, `_`, `.` or `:`, so
   * "aks" inside "peaks-cluster" is not Azure.
   */
  claims: (name: string, hasWord: (word: string) => boolean) => boolean;
  /** Right-aligned label in the context list. */
  label: string;
  /**
   * The boilerplate this vendor prepends to a cluster's real name, so a
   * fifty-character ARN can be dimmed down to the one word being looked for.
   */
  nameSeparator?: string;
  /**
   * One simplified geometric shape on a 24-box, legible at 13px beside the
   * context name. It answers "which kind of cluster am I talking to"; the
   * colour beside it answers "which one".
   */
  mark: ReactNode;
}

/**
 * Everything the app knows about one vendor, in one place.
 *
 * Every facet is optional and most vendors have one. A vendor with none is
 * a folder that does nothing, which is the correct amount of ceremony for
 * one that has not been written yet.
 */
export interface Vendor {
  /** Matches the `id` the backend's detection reports, where it detects one. */
  id: string;
  name: string;
  /**
   * What the reader gets for having it, in the words of the thing they get
   * — never a list of the objects it reads. This is the whole job of the
   * Settings row, and only a vendor with {@link Vendor.provides} has one.
   */
  gives?: string;
  provides?: Partial<Capabilities>;
  crd?: CrdView;
  nodeLabels?: NodeLabels;
  flavours?: readonly Flavour[];
}

/**
 * Declare a vendor. Only a type-check today, and that is the point: the
 * registry is a list, not a framework.
 */
export function defineVendor(vendor: Vendor): Vendor {
  return vendor;
}
