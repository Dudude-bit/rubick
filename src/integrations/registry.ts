/**
 * The seam.
 *
 * A vendor declares what it can supply and the surface asks for the facet
 * rather than for the vendor by name. A lint rule keeps that honest: nothing
 * outside `src/integrations/` may import a vendor folder.
 *
 * A vendor gets a {@link Vendor.page} when it owns objects and a topology no
 * core object can host. Prometheus gets none: every fact it has belongs on the
 * pod or node it is about. cert-manager has both — its expiry a power through
 * {@link Capabilities}, its list of failing chains a page. {@link Extension}
 * is the third thing: is it here, is it healthy, what does it give. It is a
 * field rather than a capability key, because a capability lets a surface ask
 * for a power without learning who answered and this pane's job is to name
 * the vendor.
 *
 * The tier decides a facet's runtime obligations, not where its code lives.
 *
 * - **Tier 1 — free.** {@link Vendor.nodeLabels} and {@link Vendor.flavours}
 *   are read on every cluster, always.
 * - **Tier 2 — detected.** Its state is CRDs on the same API server.
 *   {@link Vendor.crd} needs no detection call — a CRD group with no objects
 *   is never rendered — while {@link Vendor.provides} is gated on the
 *   backend's CRD scan.
 * - **Tier 3 — configured** ({@link Connect}). Its own address and usually a
 *   credential the kubeconfig does not carry, so presence is a probe with
 *   three answers and the surface owes all three: configured and silent looks
 *   exactly like never set up, and the reader blames the app rather than their
 *   monitoring. {@link CapabilityState} carries the difference and the reason.
 *
 * What lives here is knowledge about a specific vendor's product: GKE's
 * node-pool label spellings qualify even though reading node labels is tier 1,
 * generic machinery that groups a table by any key does not. **A capability
 * key is a contract, and the surface must have a real answer for its absence**
 * — `certificate.issuance` absent means the page shows the expiry it read from
 * `tls.crt` and says nothing about renewal — which is why cloud *auth* is not
 * in this tree: without it there is no kubeconfig. And **a vendor may never
 * take something away**: the core answer is drawn first and stays drawn; the
 * facet extends it.
 *
 * Deliberately absent, because a dozen static records are a list and not a
 * framework: registration order, priorities, lifecycle hooks, an event bus,
 * third-party loading.
 */

import type { Saying } from "@/i18n/say";

import type { LucideIcon } from "lucide-react";

import type { en } from "@/i18n/catalogue";
import type { ComponentType, ReactNode } from "react";

import type { IssuanceStory, LogFormat, LogLevel } from "@/generated/types";
import type { UsageSample } from "@/lib/usage-history";
import type { Delivery, DeliveryQuery } from "./gitops";
import type { CrdColumn, CrdStatus } from "./kit";
import type { InClusterHint } from "./forwarded";

/**
 * The windows a history capability can be asked for.
 *
 * Owned here rather than by whichever vendor answers, because the picker is
 * drawn by the surface: a chart offering ranges only the current supplier
 * happens to implement would change shape when the supplier did. One
 * vocabulary across every history capability — the log viewer's picker offers
 * the same four words the usage chart does — so "the last six hours" means one
 * thing in this app rather than one thing per pane.
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
 * What some other object says about how traffic reaches one Service.
 *
 * The three managed clouds each have an object that configures the load
 * balancer in front of a Service — GKE's `BackendConfig`, named by an
 * annotation on the Service; AWS's `TargetGroupBinding`, which names the
 * Service itself. They are where a managed Ingress is actually configured,
 * and today they render as anonymous custom resources nothing connects to
 * anything.
 *
 * **`summary` is configuration and never a verdict.** "health check
 * HTTP :8080/healthz" is the probe the cloud's load balancer will run; whether
 * it is passing is not in the object and must not be implied by anything drawn
 * from it. That distinction is not pedantry here — it is the whole difference
 * between this tier and the one that needs a cloud credential.
 */
export interface EdgeConfig {
  /** The object that states it, and where the reader continues. */
  source: { kind: string; name: string; to: string };
  /**
   * What it configures, in the object's own terms — as keys, since this is
   * composed inside a query. Several, joined on one line.
   */
  summary: Saying[];
  /**
   * Stated only where the object itself states it — a status field a
   * controller wrote, or a name that resolves to no object in the cluster.
   * **Never** derived from a status that is absent: a `BackendConfig` has no
   * status at all, and reading its silence as health would invent the most
   * confident wrong claim in the app.
   */
  problem: { text: Saying; tone: "warn" | "err" } | null;
}

/** What terminates TLS for one host, where `spec.tls` does not. */
export interface IngressTls {
  host: string;
  /**
   * Whether the host is served over TLS. `false` is a real answer — a vendor
   * that owns this Ingress and finds no certificate for the host is stating
   * that it serves plain HTTP, which is worth more than silence.
   */
  terminated: boolean;
  /**
   * What holds it, for the sentence: "an ACM certificate", "shop-cert". Never
   * branched on — the surface prints it. A key, because this is answered
   * inside a query; a Secret's own name goes through the verbatim one.
   */
  by: Saying;
}

/**
 * One object a custom resource points at, and what the pointing means.
 *
 * The core's connection graph is built in the backend from selectors, volumes,
 * owner references and Ingress rules — the joins that are the same on every
 * cluster. A custom resource has none of them. What an Argo `Application` is
 * connected to is whatever its controller *wrote down*: the inventory in
 * `status.resources`, the project in `spec.project`. A Flux `Kustomization`'s
 * is its `sourceRef`. Those are not a shape the core can compute and must not
 * be — the core has no business knowing what an Application is — so the vendor
 * that owns the kind answers for it.
 *
 * @see Capabilities."object.related"
 */
export interface RelatedObject {
  /**
   * What this object does with that one, in the operator's own terms:
   * "manages", "issues into", "reads from", "waits for". Printed as the row's
   * label and never branched on — a catalogue key, since these are made
   * inside a query and the panel groups by them.
   */
  relation: keyof (typeof en)["readings"];
  kind: string;
  name: string;
  namespace: string | null;
  /**
   * The API group of the far end — `""` for a core object.
   *
   * A group and not a CRD name, because a group is what an operator actually
   * records (`status.resources[].group`, an `apiVersion`) and a CRD name is
   * an address. Turning one into the other needs the cluster's CRD list,
   * which is core knowledge every reference in the app already resolves
   * through; making each vendor carry it would put the same lookup in three
   * folders and let them disagree.
   */
  group: string | null;
  /**
   * The controller's own sentence about *this* link — why it could not be
   * applied, why it is out of sync. Verbatim, and absent where the controller
   * said nothing. Never a sentence this app composed: a paraphrase of
   * somebody else's failure is a second guess at it.
   */
  note?: string | null;
  /** Only where the controller reported a problem with the link itself. */
  tone?: "warn" | "err";
}

/** One way in to a Service, as the object that routes it states it. */
export interface ServiceRoute {
  /** The hostname a client types. */
  host: string;
  /** The path it reaches the Service on; `/` where the route names none. */
  path: string;
  /**
   * Whether that host is served over TLS — and `null` where the vendor could
   * not read enough to say.
   *
   * Three answers rather than a boolean, because the second-worst thing this
   * capability could do is replace a wrong sentence with a wrong scheme.
   * Traefik binds a router to entry points that live only in the proxy's
   * start-up flags: with those unread, an IngressRoute naming no Secret is
   * *either* plain HTTP or a TLS entry point serving the default certificate,
   * and nothing in the API server distinguishes them. A consumer offers no
   * link for `null` and names the host instead.
   */
  tls: boolean | null;
  /**
   * The route pins an h2c (gRPC) scheme on its backend, so a browser sent
   * to this host gets no page — it is a way in for a CLI, not for a link.
   * Optional because most vendors cannot state it and absence means "not
   * known to be", which consumes the same as false.
   */
  h2c?: boolean;
  /**
   * The object that routes it, so the reader can go and read it. `crd` is
   * the definition that serves the kind — `<plural>.<group>` — so a consumer
   * can draw the source as a real reference, peek and all; absent for a core
   * kind, or where the vendor cannot say.
   */
  source: { kind: string; name: string; namespace: string; crd?: string };
  /**
   * Where that object's page is, supplied by the vendor because only the
   * vendor knows its CRD's group. Absent for a core kind, which the consumer
   * can link on its own.
   */
  to?: string;
}

/** What stands behind a Service that is a proxy's own front door. */
export interface ProxyBehind {
  /** The vendor's display name — "Traefik". */
  vendor: string;
  /** Where the hosts it serves are drawn. */
  to: string;
  /** How many hostnames it currently serves. */
  hosts: number;
}

/**
 * Every capability the app knows how to consume, and its contract.
 *
 * Plain async functions rather than components or hooks: the surface owns how
 * it fetches and how it draws, so the vendor cannot smuggle a layout decision
 * across the seam, and a surface can call one inside its own `useQuery`
 * without any rules-of-hooks trouble.
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
   * Whether this Service is a proxy the vendor owns — and what stands
   * behind it, for the surface looking at the object in front of it. A
   * defaultBackend Ingress sending everything to Traefik is not a routing
   * dead end; it is a door, and this is the sign on it. `null` for any
   * Service that is not the vendor's own.
   */
  "proxy.behind": (input: {
    namespace: string;
    name: string;
  }) => Promise<ProxyBehind | null>;
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
   * No amount of client-side buffering closes this: `--previous` reaches one
   * run back and only while the pod object is still there, so a crashed pod
   * its ReplicaSet has already replaced takes its log with it. A store that
   * was shipped to has them.
   *
   * Absent means the viewer is exactly what it is today: the live stream, the
   * previous run where the kubelet still holds one, and a pod that is gone
   * says so and stops. The offer appears only where the reader has just been
   * told there is nothing to read; nothing else is removed or dimmed.
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
   * The one capability here whose absence has **no** core answer: with no
   * supplier the row is simply not drawn, with no placeholder and no
   * invitation. The single quiet line under Usage already carries the offer
   * for the whole app, so a "connect a Prometheus" nag on every page would be
   * one advert per surface.
   */
  "network.traffic": (input: {
    scope: UsageScope;
    range: UsageRange;
  }) => Promise<TrafficWindow>;
  /**
   * What a cloud's own object configures about the way into this Service.
   *
   * A list rather than one answer, because a Service may genuinely have
   * several — a `BackendConfig` per port, or two `TargetGroupBinding`s for
   * two listeners — and picking one would hide the other. Empty is the
   * ordinary answer even on a cluster that has the CRDs.
   *
   * Absent means the traffic chain draws exactly the Service hop it draws
   * today. This capability only ever *adds* a line under a hop that already
   * reads whole, which is the rule for every extension in this tree and is
   * load-bearing here: the chain must say the same thing about a Service on
   * a cluster nobody has ever pointed at a cloud.
   */
  "service.edge": (input: {
    namespace: string;
    name: string;
  }) => Promise<EdgeConfig[]>;
  /**
   * Which hostnames from outside the cluster reach this Service, when the
   * thing that routes them is the vendor's own object rather than an Ingress.
   *
   * The app's connection graph is built in the backend from `Ingress` and
   * nothing else, which is correct: a `Routes` edge out of a Traefik
   * `IngressRoute` would be vendor knowledge in the core, and the core has no
   * business knowing what an IngressRoute is. So the vendor answers for its
   * own objects, in the same shape a core Ingress would have given —
   * otherwise a cluster whose entire edge is CRDs is told *by the app* that
   * nothing routes to anything, which is a false claim rather than silence.
   *
   * Absent means every surface draws what it drew before: the Ingresses the
   * core found, and a sentence about *those* rather than about the cluster.
   * A consumer must phrase its empty case accordingly — "no Ingress serves
   * this" is only ever a statement about Ingresses.
   */
  "service.routes": (input: {
    namespace: string;
    name: string;
  }) => Promise<ServiceRoute[]>;
  /**
   * Whether this Ingress is served over TLS, when the certificate is not in
   * `spec.tls`.
   *
   * The core Ingress list, the core Ingress page, the peek and the traffic
   * chain of every workload behind one all answer "is this served over TLS"
   * by reading `spec.tls`, which is correct on a self-managed cluster and
   * empty on all three managed clouds:
   *
   * - AWS's controller does not read `spec.tls` **at all** — the certificate
   *   is `alb.ingress.kubernetes.io/certificate-arn`, or discovered from the
   *   host
   * - Azure's serves it from a certificate installed on the Application
   *   Gateway and named in `appgw.ingress.kubernetes.io/appgw-ssl-certificate`
   * - GKE's is a `ManagedCertificate` or a pre-shared name, both annotations
   *
   * Read `spec.tls` alone and every managed cluster is told its HTTPS sites
   * are plain HTTP, and handed `http://` links to open them with.
   *
   * Answered per host and only for the hosts the vendor can speak for: a host
   * missing from the answer is not a denial, and the caller keeps whatever
   * `spec.tls` told it. Absent, every surface reads exactly as it did before.
   *
   * **Takes a list and answers positionally**, the same contract
   * {@link Capabilities."delivery.source"} has and for the same reason: the
   * Ingress list is a table, and a capability asked once per row would make
   * the column impossible — and the list is where a wrong answer shows most,
   * because it is what hands out the `http://` link somebody clicks.
   */
  "ingress.tls": (
    ingresses: Array<{ namespace: string; name: string; hosts: string[] }>
  ) => Promise<IngressTls[][]>;
  /**
   * What one custom resource is connected to, as its own controller states it.
   *
   * The gap this closes is a whole surface rather than a field.
   * `get_resource_connections` answers for nine core kinds and refuses the
   * rest, correctly, because the joins it computes do not exist for a kind it
   * has never heard of. So the object with the most connections in a GitOps
   * cluster — an Argo `Application` naming forty objects it manages — gets a
   * Connections tab from here or from nowhere.
   *
   * Asked per object rather than for a list: a Connections tab is opened for
   * one object at a time, and there is no table of custom resources this would
   * have to fill a column of.
   *
   * **`null` and `[]` are different answers, and that is the contract.**
   * `null` is "this kind is not mine" — every vendor says it about every other
   * vendor's CRDs, which is most calls. `[]` is a vendor that owns the kind
   * looking and finding nothing, which is a real state: an Application Argo
   * has not compared yet genuinely lists no resources. Collapsing the two
   * would make "no integration understands this object" and "this object is
   * connected to nothing" the same sentence, and only one of them is a fact
   * about the cluster.
   *
   * Absent altogether means no integration in the app answers at all; the
   * surface still draws the owner reference, which is upstream Kubernetes and
   * needs nobody.
   */
  "object.related": (input: {
    /** The API group of the subject, so a vendor can decline another's kind. */
    group: string;
    kind: string;
    namespace: string | null;
    name: string;
  }) => Promise<RelatedObject[] | null>;
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
  /**
   * How this vendor's own Service is usually labelled, so the app can offer
   * to forward a port to it instead of asking for an address.
   *
   * The observation behind it: a configured integration needs to know *which*
   * server, and a Service in this cluster names one as exactly as a URL does
   * — while being something the app can already reach. Without this the
   * reader is asked for an address their machine can get to, and the obvious
   * one, the in-cluster name, is the one that cannot work.
   *
   * Absent, the dialog asks for an address and nothing else, which is right
   * for a vendor that does not run in the cluster at all.
   */
  inCluster?: InClusterHint;
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
  | {
      ok: false;
      at: number;
      /**
       * Why, as a {@link Saying}: a probe runs where the reader's language
       * is not in scope, and the transport's own words ride inside it.
       */
      reason: Saying;
    };

/**
 * One thing an extension is currently doing for this cluster.
 *
 * A count is quiet and a problem is coloured, which is the same discipline
 * the condition rows and the tab marks already follow: `7 certificates` is
 * inventory and `1 renewal failing` is why you came. Borrowing a tone for
 * inventory spends the only signal this row has.
 */
export type VendorFact = {
  /** Only a problem has one. */
  tone?: "warn" | "err";
  /**
   * Where the reader continues, and the reason this stays a status list
   * rather than growing into a dashboard: every fact ends in the part of
   * the app already built for the objects it counted.
   */
  to?: string;
} & (
  | {
      /**
       * What the line says, as a catalogue key. Facts are composed inside a
       * query, where the reader's language is not in scope — see
       * {@link Saying}.
       *
       * Several, where one line counts several things: `3 Gateways · 2
       * VirtualServices`. Each part is counted in its own language and the
       * page joins them, because a count is not a substring one language can
       * hand to another.
       */
      say: Saying | Saying[];
      text?: never;
    }
  | {
      /**
       * A value that is not language: a hostname, a version, an address.
       * Translating one would be a bug, so it takes this side instead.
       */
      text: string;
      say?: never;
    }
);

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
  gives: keyof typeof en.vendor;
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
 * How a sidebar row gets its number: the page's *own* query, plus the
 * arithmetic that turns its answer into a count.
 *
 * A query rather than a `() => Promise<number>`, so the row and the page share
 * one cache entry: the row pays for the read and opening the page costs
 * nothing. A count fetching under a key of its own would list every Ingress,
 * every IngressRoute and every Middleware twice, once for the screen and once
 * for the number beside its name.
 *
 * `staleTime` is the vendor's, because a routing table and a delivery
 * pipeline do not go out of date at the same speed. Nothing here polls.
 *
 * The shell prefixes {@link queryKey} with the cluster context before it runs
 * the query — cluster B must never read cluster A's numbers, the same rule the
 * detection scan states. A page that wants to share the cache entry prefixes
 * its own reads the same way: `[context, ...KEY]`.
 */
export interface PageCount {
  queryKey: readonly unknown[];
  queryFn: () => Promise<unknown>;
  /**
   * How many of the things the page actually lists, which is the same rule
   * the resource rows follow.
   *
   * Not "how many of the vendor's CRDs exist": Traefik on a k3d cluster
   * serves plain Ingresses and may own no IngressRoute at all, and a row
   * reading `0` over a page with twelve hosts on it would be a lie about an
   * empty page. `null` is the answer where the cluster refused to say, and
   * draws nothing rather than a zero.
   */
  select: (data: never) => number | null;
  /**
   * The dot beside the number: the worst thing on the page, or nothing.
   *
   * Same discipline the facts follow — inventory is quiet, a problem is
   * coloured — spent on one pixel next to the count instead of on the
   * count itself. Read from the same payload `select` reads, so the dot
   * never costs a query the row was not already paying for.
   */
  tone?: (data: never) => "warn" | "err" | null;
  staleTime: number;
}

/**
 * Declare a page's count. Only a type-check, and one job: binding the payload
 * type across `queryFn` and `select` at the call site, then erasing it, so the
 * registry can hold every vendor's count in one list without knowing what any
 * of them reads.
 */
export function pageCount<T>(count: {
  queryKey: readonly unknown[];
  queryFn: () => Promise<T>;
  select: (data: T) => number | null;
  tone?: (data: T) => "warn" | "err" | null;
  staleTime: number;
}): PageCount {
  return count as PageCount;
}

/**
 * The screen a vendor owns, and its row in the sidebar.
 *
 * Declared here for the same reason {@link Extension} is: the shell needs a
 * route, a label, a glyph and a number, and must get all four without learning
 * that Traefik exists. `App.tsx` serves one route for every vendor page there
 * will ever be, and the sidebar category is derived rather than written — so a
 * second vendor page costs one folder and one line in {@link VENDORS}, and no
 * file outside this tree changes.
 *
 * A page belongs to a vendor that also declares an {@link Extension}, and that
 * is not a formality: the row takes its name and its glyph from the extension,
 * and the category lists only *detected* extensions, so a vendor with a page
 * and no extension would have a screen nothing could reach.
 */
export interface VendorPage {
  /**
   * The number at the end of the sidebar row. See {@link PageCount}.
   *
   * Optional, because a page's subject is not always countable. Prometheus is
   * the first: its page answers *whether the Prometheus you connected is
   * watching this cluster*, and there is no honest integer for that — a row
   * reading "4" beside it would be counting something the page is not about.
   * The row then carries the vendor's name and nothing after it.
   */
  count?: PageCount;
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
  "k3d" | "k3s" | "eks" | "gke" | "aks" | "minikube" | "generic";

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
