/**
 * Centralized query key factory for React Query
 *
 * Ensures consistent query keys across the application.
 * Using "all" instead of null/undefined for namespace to avoid cache issues.
 */

import { ResourceKind, toPlural } from "./resource-registry";

export const queryKeys = {
  // Resource lists
  resources: (type: ResourceKind, namespace?: string | null): string[] => [
    toPlural(type),
    namespace ?? "all",
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
      namespace ?? "all",
    ],
    nodes: (): string[] => ["metrics", "nodes"],
  },

  // Events
  events: (namespace?: string | null): string[] => [
    "events",
    namespace ?? "all",
  ],

  // Pods (special case - used by multiple components)
  pods: (namespace?: string | null): string[] => ["pods", namespace ?? "all"],

  // Namespaces
  namespaces: (): string[] => ["namespaces"],

  // Contexts
  contexts: (): string[] => ["contexts"],

  // Helm
  helm: {
    releases: (namespace?: string | null): string[] => [
      "helm",
      "releases",
      namespace ?? "all",
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
  customResources: (
    group: string,
    version: string,
    plural: string,
    namespace?: string | null
  ): string[] => [
    "customResources",
    group,
    version,
    plural,
    namespace ?? "all",
  ],
};
