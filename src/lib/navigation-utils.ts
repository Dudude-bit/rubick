import { toPlural, type ResourceKind } from "./resource-registry";

/**
 * Get the URL for a resource detail page
 *
 * @param resourceKind - The kind of the resource (e.g., "Pod", "Deployment")
 * @param name - Name of the resource
 * @param namespace - Namespace of the resource (optional for cluster-scoped resources)
 * @returns URL path for the resource detail page
 *
 * @example
 * getResourceDetailUrl("Pod", "my-pod", "default") // "/pods/default/my-pod"
 * getResourceDetailUrl("Node", "node-1") // "/nodes/node-1"
 */
export function getResourceDetailUrl(
  resourceKind: ResourceKind | string,
  name: string,
  namespace?: string | null
): string {
  const plural = toPlural(resourceKind as ResourceKind);
  if (namespace) {
    return `/${plural}/${namespace}/${name}`;
  }
  return `/${plural}/${name}`;
}
