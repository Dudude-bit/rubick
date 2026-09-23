/**
 * Query keys for React Query, in one place so they cannot drift.
 * Namespace-less keys carry {@link EVERY_NAMESPACE} rather than null.
 *
 * A fact read in more than one place gets a builder here, and every reader,
 * prefetcher and invalidator of it uses that builder. A key typed by hand in
 * two files is two cache entries the day one of them changes: the fact is
 * fetched twice, and an invalidation reaches only the copy it was written
 * next to.
 */

import { scopeCacheKey } from "./namespace-scope";
import { ResourceKind, ResourceType, toPlural } from "./resource-registry";

/**
 * "Every namespace", written so that no namespace can be mistaken for it.
 *
 * `all` is a name a namespace can actually have — the API server takes
 * `kubectl create namespace all` without complaint — so keying rows under it
 * made "that namespace" and "the whole cluster" one question, and whichever
 * was asked first answered the other. `*` is not a name it can have: names
 * are RFC-1123 labels, so the server rejects it outright, which is exactly
 * what a sentinel needs to be.
 */
export const EVERY_NAMESPACE = "*";

/**
 * The one spelling of "every namespace" a key is allowed to carry.
 *
 * The app says it two ways: `clusterStore.currentNamespace` is `""` when
 * nothing is selected, and callers that pass it to a Tauri command turn it
 * into `null` first, because the backend wants an absent namespace rather
 * than a blank one. Both have to land here — miss one and the same list lives
 * under two keys at once, with the connect-time prefetch warming the one no
 * reader reads.
 *
 * `||` rather than `??` because empty is not a namespace either. A name is
 * one to sixty-three characters, so `""` can only have meant "all", and a
 * key builder that treats it as a name is inventing a namespace nobody can
 * create.
 */
function scope(namespace?: string | null): string {
  return namespace || EVERY_NAMESPACE;
}

/**
 * The namespace of one object, or `null` for a cluster-scoped one. A detail
 * page reads it from the route, where it is `undefined`; a peek reads it off
 * the target, where it is `null`. React Query hashes both alike but matches
 * an invalidation filter by value, so one of them has to be picked here.
 */
function home(namespace?: string | null): string | null {
  return namespace || null;
}

export const queryKeys = {
  // Resource lists
  resources: (type: ResourceKind, namespace?: string | null): string[] => [
    toPlural(type),
    scope(namespace),
  ],
  /** Every list of one kind, whatever its scope: what a mutation marks stale. */
  lists: (type: ResourceKind): string[] => [toPlural(type)],

  /**
   * One object, as its detail page reads it: the kind singular and
   * lowercased, apart from the plural-first lists. The peek panel, the
   * events timeline and every other reader of the same `get_*` answer share
   * this entry, so an action that invalidates the object reaches all of them.
   */
  detail: (
    kind: string,
    namespace: string | null | undefined,
    name: string | undefined
  ): (string | null | undefined)[] => [
    kind.toLowerCase(),
    home(namespace),
    name,
  ],
  /** Every object of one kind: the prefix a mutation of that kind marks stale. */
  details: (kind: string): string[] => [kind.toLowerCase()],

  /** One object's manifest as YAML, from `get_manifest`. */
  manifest: (
    kind: string,
    namespace: string | null | undefined,
    name: string | undefined
  ): (string | null | undefined)[] => [
    "manifest",
    kind.toLowerCase(),
    home(namespace),
    name,
  ],
  everyManifest: (): string[] => ["manifest"],

  /**
   * The pods a controller owns, found the way its detail page finds them.
   * `selector` is the DaemonSet's, the only kind that is looked up by one
   * the object itself carries.
   */
  ownedPods: (
    kind: string,
    namespace: string | null | undefined,
    name: string | undefined,
    selector?: string | null
  ): (string | null | undefined)[] => [
    "owned-pods",
    kind,
    home(namespace),
    name,
    selector || null,
  ],
  everyOwnedPods: (): string[] => ["owned-pods"],

  // Metrics
  metrics: {
    pods: (namespace?: string | null): string[] => [
      "metrics",
      "pods",
      scope(namespace),
    ],
    nodes: (): string[] => ["metrics", "nodes"],
  },

  // Events
  events: (namespace?: string | null): string[] => ["events", scope(namespace)],

  /**
   * The pod list as the table draws it: `PodRow`s from `listPodRows`, not
   * `PodInfo`s. Its own key because the two shapes must never share a cache
   * entry, and because `["pods", ns, name]` was once a detail key.
   */
  podRows: (namespace?: string | null): string[] => [
    "pod-rows",
    scope(namespace),
  ],
  /** The pod table in every scope it has been read in. */
  everyPodRows: (): string[] => ["pod-rows"],

  /**
   * `list_namespaces` as a plain read. Not the Namespaces page's list, which
   * a watch writes into (`resources(Namespace)`): what a reader sees there is
   * whatever the last watch tick built.
   */
  namespaces: (): string[] => ["namespaces"],

  /**
   * The nodes nothing is heard from. Its own key, not the node list's: this
   * one is derived, polled at a different rate, and shared by every surface
   * that draws pods.
   */
  silentNodes: (): string[] => ["nodes", "silent"],

  /**
   * The cluster overview for one scope: the namespaces it adds up, or none
   * for the whole cluster. The context is the second element because
   * `ofSameCluster` reads it from there.
   */
  clusterOverview: (
    context: string | null,
    namespaces: readonly string[] = []
  ): (string | null)[] => [
    "cluster-overview",
    context,
    scopeCacheKey(namespaces) ?? EVERY_NAMESPACE,
  ],

  appInfo: (): string[] => ["app-info"],

  // Contexts and what is bound to them
  contexts: (): string[] => ["contexts"],
  contextBindings: (): string[] => ["context-bindings"],
  contextBinding: (context: string | null): (string | null)[] => [
    "context-bindings",
    context,
  ],
  gcpProfiles: (): string[] => ["gcp-profiles"],
  azureProfiles: (): string[] => ["azure-profiles"],
  shareTargets: (): string[] => ["share-targets"],

  /**
   * What is saved for a connected integration, and whether it answers.
   * Keyed by the vendor's id so nothing here names a vendor.
   */
  integrationConnection: (
    vendorId: string,
    context: string | null
  ): (string | null)[] => ["integration-connection", vendorId, context],
  integrationProbe: (
    vendorId: string,
    context: string | null
  ): (string | null)[] => ["integration-probe", vendorId, context],

  // Helm: everything about a release sits under one prefix, so a rollback or
  // an upgrade reaches the list, the release and its history at once.
  helm: {
    everyRelease: (): string[] => ["helm", "releases"],
    releases: (namespace?: string | null): string[] => [
      "helm",
      "releases",
      scope(namespace),
    ],
    release: (
      namespace: string | undefined,
      name: string | undefined
    ): (string | undefined)[] => ["helm", "releases", namespace, name],
    history: (
      namespace: string | undefined,
      name: string | undefined
    ): (string | undefined)[] => [
      "helm",
      "releases",
      namespace,
      name,
      "history",
    ],
  },

  // CRDs, keyed like any other cluster-scoped kind so that a mutation's
  // `lists`/`details` prefixes reach them.
  crds: (): string[] =>
    queryKeys.resources(ResourceType.CustomResourceDefinition, null),
  crd: (name: string | undefined): (string | null | undefined)[] =>
    queryKeys.detail(ResourceType.CustomResourceDefinition, null, name),
  /**
   * The rows of one CRD. Keyed by the CRD's own name, which is what the
   * reader picked and what the watch subscribes to — group, version and
   * plural are all derivable from it and only make a longer key that says
   * the same thing.
   */
  customResourceList: (
    crdName: string,
    namespace?: string | null
  ): string[] => ["custom-resources", crdName, scope(namespace)],
  customResourceLists: (crdName: string): string[] => [
    "custom-resources",
    crdName,
  ],
  customResource: (
    crdName: string,
    namespace: string | null | undefined,
    name: string | undefined
  ): (string | null | undefined)[] => [
    "custom-resource",
    crdName,
    home(namespace),
    name,
  ],
  customResourceYaml: (
    crdName: string,
    namespace: string | null | undefined,
    name: string | undefined
  ): (string | null | undefined)[] => [
    "custom-resource-yaml",
    crdName,
    home(namespace),
    name,
  ],

  // What a ConfigMap or Secret holds, namespace before name like every key
  // here. The two readers once disagreed on the order, so an edit on the
  // ConfigMap's page never reached the pod's environment tab.
  configMapData: (
    namespace: string | null | undefined,
    name: string | undefined
  ): (string | null | undefined)[] => ["configmap-data", home(namespace), name],
  secretData: (
    namespace: string | null | undefined,
    name: string | undefined
  ): (string | null | undefined)[] => ["secret-data", home(namespace), name],

  deploymentReplicaSets: (
    namespace: string | null | undefined,
    name: string | undefined
  ): (string | null | undefined)[] => [
    "deployment-replicasets",
    home(namespace),
    name,
  ],

  // Routing. The cluster-wide Gateways every verdict is drawn from: the list
  // command's answer, never the Gateway page's watched entry — a watch row
  // carries no listener sets — but under its prefix, so a Gateway's
  // mutations still reach it.
  gateways: (): string[] => [
    ...queryKeys.resources(ResourceType.Gateway, null),
    "listed",
  ],
  gatewayClasses: (): string[] =>
    queryKeys.resources(ResourceType.GatewayClass, null),
  backendTlsPolicies: (namespace: string): string[] => [
    "backend-tls-policies",
    namespace,
  ],
  ingressClass: (className: string | null | undefined): (string | null)[] => [
    "ingress-class",
    className ?? null,
  ],
  /** Sorted and deduplicated here, so every reader asks the same question. */
  tlsCertificates: (
    namespace: string | undefined,
    secretNames: readonly string[]
  ): (string | undefined)[] => [
    "tls-certificates",
    namespace,
    [...new Set(secretNames)].sort().join(","),
  ],
};
