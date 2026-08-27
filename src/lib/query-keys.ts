/**
 * Centralized query key factory for React Query
 *
 * Ensures consistent query keys across the application.
 * Namespace-less keys carry {@link EVERY_NAMESPACE} rather than null.
 */

import { ResourceKind, toPlural } from "./resource-registry";

/**
 * "Every namespace", written so that no namespace can be mistaken for it.
 *
 * It used to be the word `all`, which is a name a namespace can actually
 * have — the API server takes `kubectl create namespace all` without
 * complaint. So a cluster with one made the Pods page key its rows under
 * `["pods", "all"]` whether the reader had asked for that namespace or for
 * the whole cluster, and whichever question was asked first answered the
 * other. `*` is not a name it can have: names are RFC-1123 labels, so the
 * server rejects it outright, which is exactly what a sentinel needs to be.
 */
export const EVERY_NAMESPACE = "*";

/**
 * The one spelling of "every namespace" a key is allowed to carry.
 *
 * The app says it two ways. `clusterStore.currentNamespace` is `""` when
 * nothing is selected, and callers that pass it to a Tauri command turn it
 * into `null` first, because the backend wants an absent namespace rather
 * than a blank one. Five callers passed the store's `""` straight into a key
 * and eighteen passed the converted `null` — and `?? "all"` caught only the
 * second, so the same list lived under `["pods", ""]` and `["pods", "all"]`
 * at once. The connect-time prefetch warmed one and every reader read the
 * other: the work was done, paid for, and never looked at.
 *
 * `||` rather than `??` because empty is not a namespace either. A name is
 * one to sixty-three characters, so `""` can only have meant "all", and a
 * key builder that treats it as a name is inventing a namespace nobody can
 * create.
 */
function scope(namespace?: string | null): string {
  return namespace || EVERY_NAMESPACE;
}

export const queryKeys = {
  // Resource lists
  resources: (type: ResourceKind, namespace?: string | null): string[] => [
    toPlural(type),
    scope(namespace),
  ],

  // Resource detail
  resourceDetail: (
    type: ResourceKind,
    namespace: string,
    name: string
  ): string[] => [toPlural(type), namespace, name],

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

  // Pods (special case - used by multiple components)
  pods: (namespace?: string | null): string[] => ["pods", scope(namespace)],

  // Namespaces
  namespaces: (): string[] => ["namespaces"],

  /**
   * The nodes nothing is heard from. Its own key, not the node list's: this
   * one is derived, polled at a different rate, and shared by every surface
   * that draws pods.
   */
  silentNodes: (): string[] => ["nodes", "silent"],

  // Contexts
  contexts: (): string[] => ["contexts"],

  // Helm
  helm: {
    releases: (namespace?: string | null): string[] => [
      "helm",
      "releases",
      scope(namespace),
    ],
    release: (namespace: string, name: string): string[] => [
      "helm",
      "releases",
      namespace,
      name,
    ],
  },

  // CRDs
  crds: (): string[] => ["crds"],
  crd: (name: string): string[] => ["crds", name],
  /**
   * The rows of one CRD. Keyed by the CRD's own name, which is what the
   * reader picked and what the watch subscribes to — group, version and
   * plural are all derivable from it and only make a longer key that says
   * the same thing.
   *
   * This replaced a five-segment `customResources(group, version, plural,
   * namespace)` that no caller had ever used: the list built its key inline
   * instead, so the builder sat here being wrong in private.
   */
  customResourceList: (
    crdName: string,
    namespace?: string | null
  ): string[] => ["custom-resources", crdName, scope(namespace)],
};
