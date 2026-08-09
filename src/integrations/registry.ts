/**
 * The seam.
 *
 * A vendor declares what it can supply and the surface asks for the facet
 * rather than for the vendor by name. A lint rule keeps that honest: nothing
 * outside `src/integrations/` may import a vendor folder.
 *
 * ## Powers, and sometimes a page
 *
 * This file used to say a vendor contributes facets and never pages, and
 * used Prometheus to argue it: nobody opens a Prometheus page, they are
 * looking at a pod and want its last six hours. That is right about
 * Prometheus and wrong as a general rule, and the line it was missing is
 * this one — **a vendor gets a page when it owns objects and a topology no
 * core object can host.**
 *
 * "What hosts does this cluster serve, and where does each one go" is a real
 * question with no object to hang it off. It is not a property of a Service
 * or a Deployment; it is the routing layer's own shape, and that is what
 * earns {@link Vendor.page}. Prometheus still gets none: every fact it has
 * belongs on the pod or the node it is about, and a page would be a place to
 * go and find the same numbers with less context.
 *
 * Most vendors are both, and the halves stay honest about their jobs.
 * cert-manager's expiry belongs on the Ingress that serves the certificate —
 * a power, through {@link Capabilities} — and its list of every Certificate
 * with a failing chain belongs on a page. {@link Extension} is the third
 * thing: is it here, is it healthy, what does it give.
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
 *   cloud APIs are the first candidates. {@link Extension} already carries
 *   the shape one would need — a row is a name, a power, and a list of
 *   facts, and "connected · answered 2s ago · Edit" is a fact with a route
 *   on it — so the first tier-3 vendor adds a producer of that state, not a
 *   second kind of row. What is deliberately *not* here is a config schema,
 *   a probe or a credential store: an abstraction for zero implementations
 *   is a costume, and inventing one would also put a configured integration
 *   on screen that nobody configured.
 *
 * ## Why facts are a field and not a capability
 *
 * {@link Extension.facts} looks like it wants to be a {@link Capabilities}
 * key, and it fails both halves of what a capability key is for. A
 * capability exists so a surface can ask for a *power* without learning
 * which vendor answered; the Integrations pane is the one screen whose
 * whole job is to name the vendor, and it draws the facts directly under
 * that name. And a capability's absence must have a good answer on the
 * consuming surface — the absence of facts has no answer to give, it is
 * simply a shorter row. So it is a field on the vendor, beside the other
 * facets, and the pane reads it the same way the node list reads
 * {@link Vendor.nodeLabels}.
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

import type { LucideIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

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
 * One thing an extension is currently doing for this cluster.
 *
 * A count is quiet and a problem is coloured, which is the same discipline
 * the condition rows and the tab marks already follow: `7 certificates` is
 * inventory and `1 renewal failing` is why you came. Borrowing a tone for
 * inventory spends the only signal this row has.
 */
export interface VendorFact {
  text: string;
  /** Only a problem has one. */
  tone?: "warn" | "err";
  /**
   * Where the reader continues, and the reason this stays a status list
   * rather than growing into a dashboard: every fact ends in the part of
   * the app already built for the objects it counted.
   */
  to?: string;
}

/**
 * The row a vendor gets in Settings → Integrations.
 *
 * Structural rather than a convention about which other field is filled
 * in, and that is the point: a cluster's own flavour is a vendor in this
 * tree too, and "Google Cloud · not installed" is nonsense. GKE cannot
 * appear in that list by anybody forgetting a rule — it would have to
 * declare itself an installable extension, which it plainly is not.
 */
export interface Extension {
  /**
   * What the reader gets for having it, in the words of the thing they get
   * — never a list of the objects it reads. This is the row's whole job,
   * and it must name a power the app actually has: a row promising a
   * feature nothing implements is an advert, and this screen has none.
   */
  gives: string;
  icon: LucideIcon;
  /**
   * What it is doing for this cluster right now — the second half of the
   * same sentence `gives` starts.
   *
   * Optional per vendor, and it has to be: the tree is cheap to add to
   * exactly because a vendor may declare one facet and no others, and a
   * row with nothing but `gives` is still worth drawing. Called only for
   * a vendor the cluster actually has, and never for an absent one — the
   * objects it would count do not exist.
   */
  facts?: () => Promise<VendorFact[]>;
}

/**
 * The screen a vendor owns, and its row in the sidebar.
 *
 * Declared here for the same reason {@link Extension} is: the shell needs a
 * route, a label, a glyph and a number, and it must get all four without
 * learning that Traefik exists. `App.tsx` serves one route for every vendor
 * page there will ever be, and the sidebar category is derived rather than
 * written — so a second vendor page costs one folder and one line in
 * {@link VENDORS}, and no file outside this tree changes.
 *
 * A page belongs to a vendor that also declares an {@link Extension}, and
 * that is not a formality: the row takes its name and its glyph from the
 * extension, and the category lists only *detected* extensions, so a vendor
 * with a page and no extension would have a screen nothing could reach.
 */
export interface VendorPage {
  /**
   * The number at the end of the sidebar row — how many of the things the
   * page actually lists, which is the same rule the resource rows follow.
   *
   * Not "how many of the vendor's CRDs exist": Traefik on a k3d cluster
   * serves plain Ingresses and may own no IngressRoute at all, and a row
   * reading `0` over a page with twelve hosts on it would be a lie about an
   * empty page. `null` is the answer where the cluster refused to say, and
   * draws nothing rather than a zero.
   */
  count: () => Promise<number | null>;
  /**
   * The page, imported when the reader opens it. A vendor page is a whole
   * screen with its own parsing and its own queries; keeping it out of the
   * first chunk is the difference between a facet and a cost everybody pays.
   */
  load: () => Promise<{ default: ComponentType }>;
}

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
   *
   * Absent where the vendor has no mark a reader would recognise at that
   * size — k3s and k3d wear the Kubernetes heptagon, and inventing
   * something for them would state what the app does not know.
   */
  mark?: ReactNode;
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
  extension?: Extension;
  /** Also the URL segment: `/integrations/<id>`. */
  page?: VendorPage;
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
