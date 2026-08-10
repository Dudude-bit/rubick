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
 *   the kubeconfig does not carry, so "is it there" is a probe rather than a
 *   lookup — and the answer has three values, not two. {@link Connect} is
 *   that shape, and Prometheus is the first vendor to declare one. It stayed
 *   out of this file until there was an implementation on purpose: an
 *   abstraction for zero implementations is a costume, and a config schema
 *   with nothing behind it would have put a configured integration on screen
 *   that nobody configured. The row it produces is still the row
 *   {@link Extension} already described — a name, a power, and facts —
 *   because "connected · answered 2s ago" is a fact.
 *
 * ## Configured is three states, and the surface owes all three
 *
 * A detected vendor is present or absent, and absence has one answer. A
 * configured one adds a third: **configured and not answering**, which is
 * the state that quietly ruins a feature. Falling back silently makes a
 * broken Prometheus look identical to one nobody ever set up, and the reader
 * concludes the app is broken rather than their monitoring. So
 * {@link CapabilityState} hands the surface the difference and the reason,
 * and a surface that consumes a capability must draw all three — see
 * {@link Capabilities} for what each key's absence is allowed to mean.
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

import type { IssuanceStory, LogFormat, LogLevel } from "@/generated/types";
import type { UsageSample } from "@/lib/usage-history";
import type { Delivery, DeliveryQuery } from "./gitops";
import type { CrdColumn, CrdStatus } from "./kit";

/**
 * The windows a history capability can be asked for.
 *
 * Owned here rather than by whichever vendor answers, because the picker is
 * drawn by the surface: a chart offering ranges only the current supplier
 * happens to implement would change shape when the supplier did.
 *
 * One vocabulary across every history capability, and that is worth stating:
 * the log viewer's range picker offers the same four words the usage chart
 * does, so "the last six hours" means one thing in this app rather than one
 * thing per pane.
 */
export const USAGE_RANGES = ["15m", "1h", "6h", "24h"] as const;

export type UsageRange = (typeof USAGE_RANGES)[number];

/** How far back each range reaches. The only fact about a range that every
 *  supplier needs, whatever it is being asked for. */
export const RANGE_WINDOW_MS: Readonly<Record<UsageRange, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

/**
 * What a chart is asking about, in terms every monitoring system can
 * express: a pod by name, a workload by what controls it, or a node.
 *
 * A workload names its controller rather than its current pods on purpose —
 * the pods it had an hour ago are gone from every list the API server will
 * answer, and a supplier that matched only the live ones would draw a chart
 * that goes blank at the last rollout.
 */
export type UsageScope =
  | { kind: "pod"; namespace: string; pod: string }
  | { kind: "workload"; namespace: string; owner: string; ownerKind: string }
  | { kind: "node"; node: string };

/**
 * A range of readings, and the two things the chart must say about them.
 *
 * `resolution` is not decoration. A supplier answering a 24h window is
 * summarising eighty-six thousand seconds into a hundred-odd points, and a
 * reader deciding whether a spike is real needs to know how wide a bucket
 * is and whether it holds the peak or an average. The app's own watched
 * window takes the max of its buckets and says so; anything answering this
 * capability owes the same sentence.
 */
export interface UsageWindow {
  samples: readonly UsageSample[];
  /** "30s buckets, max over a 15s resolution". */
  resolution: string;
}

/**
 * What a log question is about, in terms a log store can express.
 *
 * The same two shapes {@link UsageScope} has and for the same reason — a
 * workload names its controller rather than its current pods, because the
 * pods it had an hour ago are gone from every list the API server will
 * answer and they are exactly the ones worth reading.
 *
 * No node scope: a node's logs are the kubelet's and the container runtime's,
 * which is a different question with a different answer, and pretending it is
 * this one would put every pod on the node into a pane labelled with the
 * node's name.
 */
export type LogScope =
  | { kind: "pod"; namespace: string; pod: string }
  | { kind: "workload"; namespace: string; owner: string; ownerKind: string };

/** One line a log store kept, in the shape the viewer already draws. */
export interface HistoryLine {
  /** The store's own clock, in epoch ms. Never arrival order. */
  epoch: number;
  /**
   * Opaque cursor for {@link LogHistory.before}. A string because the store's
   * precision is finer than a JavaScript number holds, and rounding it would
   * make "older than this" either repeat lines or step over them.
   */
  cursor: string;
  message: string;
  raw: string;
  pod: string;
  container: string;
  namespace: string;
  level: LogLevel | null;
  format: LogFormat;
  fields: Record<string, string> | null;
}

/**
 * One page of history, and everything that must be said about it.
 *
 * The three extra fields are the whole difference between an integration
 * that helps and one that misleads. A log pane is the surface where a
 * partial answer is most dangerous: it has no axis and no total, so a page
 * that stopped at a limit looks exactly like a workload that went quiet.
 */
export interface LogHistoryPage {
  /** Oldest first. */
  lines: readonly HistoryLine[];
  /**
   * The limit was reached: these are the **newest** lines of the range asked
   * for, and there is more inside it. A surface must say so.
   */
  truncated: boolean;
  /** The limit that was actually applied, for the sentence that says it. */
  limit: number;
  /**
   * How many distinct streams answered.
   *
   * Zero with a pod that plainly existed is the label-mismatch case, and it
   * is the single most likely way this capability is quietly wrong: the
   * default shipper labels are `namespace`, `pod` and `container`, and an
   * install that relabels them answers every query with nothing. A surface
   * owes that sentence rather than an empty pane, which reads as "this pod
   * never logged".
   */
  streams: number;
  /** The label names the query used, so the sentence can name them. */
  labelsTried: readonly string[];
}

/** What to ask a log store for. */
export interface LogHistory {
  scope: LogScope;
  range: UsageRange;
  /**
   * Page backwards: only lines older than this cursor. Absent for the first
   * page, which is the only one anything fetches on its own.
   */
  before?: string;
}

/** Bytes in and out, over the same window and buckets as {@link UsageWindow}. */
export interface TrafficWindow {
  points: ReadonlyArray<{ t: number; rx: number | null; tx: number | null }>;
  resolution: string;
}

/**
 * How full one volume is, as two numbers rather than a percentage.
 *
 * `capacityBytes` is what the kubelet says the filesystem behind the volume
 * holds, which for a provisioner that enforces no quota is the node's disk
 * and not the claim's declared size. Both numbers are handed over so the
 * surface can say which is which instead of printing a share of something
 * unnamed.
 */
export interface VolumeFullness {
  claim: string;
  usedBytes: number;
  capacityBytes: number;
}

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
  /**
   * Who applied these objects, and whether a hand edit here survives.
   *
   * **Takes a list and answers positionally**, and that is the contract, not
   * an optimisation: the claim is a label the object already carries, so a
   * five-hundred-row page can be answered by one read of the owners. A
   * per-object signature would have been honest-looking and would have made
   * the list column impossible.
   *
   * `null` at a position means that object carries no claim at all — the
   * ordinary answer on the ordinary cluster, and the whole reason nothing is
   * marked for it. An object that is *labelled* and not confirmed is a third
   * answer with its own words; see {@link Delivery}.
   *
   * Absent means neither delivery controller is installed, which is the state
   * most clusters are in: every surface draws exactly what it drew before this
   * capability existed, with no column, no mark and no gap where one would go.
   */
  "delivery.source": (
    objects: DeliveryQuery[]
  ) => Promise<Array<Delivery | null>>;
  /**
   * Usage over a window longer than this app has been open.
   *
   * Absent means the chart draws the window it watched itself, which is a
   * good answer and the one every cluster gets — `metrics.k8s.io` serves the
   * last thirty seconds and has no concept of yesterday, so the only history
   * that can exist without this capability is the buffer the app fills while
   * a page is open. The ranges dim; nothing else changes.
   */
  "usage.history": (input: {
    scope: UsageScope;
    range: UsageRange;
  }) => Promise<UsageWindow>;
  /**
   * The lines a pod wrote before it stopped existing.
   *
   * The biggest hole in this app's log viewer, and the one no amount of
   * client-side buffering closes: `--previous` reaches one run back and only
   * while the pod object is still there, so a crashed pod that its
   * ReplicaSet has already replaced takes its log with it. A store that was
   * shipped to has them.
   *
   * Absent means the viewer is exactly what it is today: the live stream, the
   * previous run where the kubelet still holds one, and a pod that is gone
   * says so and stops. Nothing is removed, nothing is dimmed, and no pane
   * that reads fine today starts nagging — the offer appears only where the
   * reader has just been told there is nothing to read.
   *
   * **Never live.** This answers a closed range and returns a page; it is not
   * a second subscription and must not be drawn as one. A pane holding
   * history says so, and Follow has nothing to follow.
   */
  "logs.history": (input: LogHistory) => Promise<LogHistoryPage>;
  /**
   * How full a namespace's volumes actually are.
   *
   * Absent means the storage summary says what it says today — the declared
   * size, and a sentence stating plainly that it is not fullness. Present,
   * the row gains used and capacity. A claim missing from the answer keeps
   * the fallback sentence rather than drawing an empty bar: no kubelet
   * scraping and an unprovisioned volume look the same from here, and an
   * empty bar would read as "0% full" for both.
   */
  "volume.fullness": (input: {
    namespace: string;
    claims: string[];
  }) => Promise<VolumeFullness[]>;
  /**
   * Bytes in and out of a workload's pods.
   *
   * The one capability here whose absence has **no** core answer, and the
   * consequence is spelled out rather than worked around: with no supplier
   * the row is simply not drawn. It gets no placeholder and no invitation —
   * a "connect a Prometheus" nag on every page would be an advert repeated
   * once per surface, and the single quiet line under Usage already carries
   * the offer for the whole app.
   */
  "network.traffic": (input: {
    scope: UsageScope;
    range: UsageRange;
  }) => Promise<TrafficWindow>;
}

export type CapabilityKey = keyof Capabilities;

/**
 * What a surface gets when it asks for a capability.
 *
 * Three answers rather than an implementation or `null`, because a
 * configured vendor can fail in a way a detected one cannot, and the
 * difference is the whole reason this state exists. `absent` and
 * `unreachable` both mean "draw the core answer"; only one of them owes the
 * reader a sentence about why the extra is missing.
 *
 * `vendor` is the supplier's own name and `endpoint` its address, both for
 * *copy* — "from prometheus.monitoring:9090" is what makes a chart's numbers
 * attributable. Naming a vendor in a sentence was never the thing the seam
 * forbids; naming one in an `import` is. A surface must not branch on either.
 */
export type CapabilityState<K extends CapabilityKey> =
  | { state: "absent" }
  | { state: "unreachable"; vendor: string; endpoint: string; reason: string }
  | {
      state: "ready";
      vendor: string;
      endpoint: string;
      use: Capabilities[K];
    };

/**
 * A vendor the reader gives an address to.
 *
 * Declaring this is what makes a vendor tier 3: it is never detected, its
 * powers are gated on {@link probe} rather than on a CRD scan, and the
 * Integrations row grows a Connect button instead of the word "detected".
 *
 * Every function takes no context argument — the backend reads the current
 * kubeconfig context itself and stores per cluster, because a Prometheus is
 * per cluster and threading the context through the UI would make it
 * possible to save one cluster's address against another.
 */
export interface Connect {
  /** Shown in the empty address field, so the expected shape is visible. */
  urlPlaceholder: string;
  /** What this cluster has saved, or `null` where nobody configured one. */
  read: () => Promise<SavedConnection | null>;
  save: (draft: ConnectionDraft) => Promise<void>;
  forget: () => Promise<void>;
  /**
   * The Test button's answer, and the same check that decides whether the
   * powers are offered at all. Given a draft it answers the form on screen;
   * given nothing it answers what is saved.
   */
  probe: (draft?: ConnectionDraft) => Promise<ProbeResult>;
  /**
   * The row's facts for a connection that answered — the endpoint, when it
   * last did, and what that buys. Pure, because the probe already did the
   * asking.
   */
  facts: (saved: SavedConnection, probe: ProbeResult) => VendorFact[];
}

/**
 * A saved connection as the webview is allowed to see it.
 *
 * There is no token field and that is structural rather than an omission:
 * a credential that never crosses the boundary cannot be logged by the
 * renderer, read out of a devtools session, or persisted into some store
 * nobody audited. `hasToken` is all the form needs — it draws a filled
 * field it will not read back, and an empty submission means "leave it".
 */
export interface SavedConnection {
  url: string;
  authType: "none" | "bearer";
  hasToken: boolean;
  insecureTls: boolean;
}

/** What the form sends. An empty `token` keeps whatever is already stored. */
export interface ConnectionDraft {
  url: string;
  authType: "none" | "bearer";
  token: string;
  insecureTls: boolean;
}

/**
 * Whether it answered, and — when it did not — its own words about why.
 *
 * The reason is never paraphrased. "no route to host" and "401 Unauthorized"
 * send the reader to two completely different places, and a single "could
 * not connect" sends them nowhere.
 */
export type ProbeResult =
  | {
      ok: true;
      at: number;
      latencyMs: number;
      version: string | null;
      /**
       * How far back this supplier says it can answer, in its own words —
       * and **only where it said so**. `null` is not "unlimited", it is "it
       * did not tell us", and a row printing a guessed retention would be
       * the most misleading fact on that screen: a reader told "3 days" who
       * then finds nothing from yesterday concludes the app is broken.
       *
       * Optional because a supplier that has no such concept has nothing to
       * report, not because it is nice to have.
       */
      retention?: string | null;
    }
  | { ok: false; at: number; reason: string };

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
  /**
   * Tier 3. Declaring this replaces detection with a probe: the vendor is
   * never looked for in the cluster, and {@link Vendor.provides} is offered
   * only while that probe is answering.
   */
  connect?: Connect;
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
