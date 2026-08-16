import { ResourceType, toPlural, type ResourceKind } from "./resource-registry";

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

const CRD_INSTANCES = toPlural(ResourceType.CustomResourceDefinition);

/**
 * Where one object of a CRD lives.
 *
 * A custom resource cannot be addressed the way {@link getResourceDetailUrl}
 * addresses everything else: its kind is not in the registry, so there is no
 * plural to build a path out of, and the CRD's own name — `<plural>.<group>`
 * — is the only thing that identifies the API it comes from. Hence the extra
 * argument, and hence this being a second function rather than a branch.
 *
 * It lives beside its sibling rather than in `src/integrations/kit.ts`, where
 * it used to: the route is one this app serves for every CRD on any cluster,
 * so knowing it is not knowledge about a vendor. What made that placement
 * wrong in practice is that `ResourceRef` needs it — a core component cannot
 * reach into the integrations tree, and a reference to a custom resource is
 * not a vendor feature.
 */
export function getCustomResourceUrl(
  crdName: string,
  name: string,
  namespace?: string | null
): string {
  const base = `/${CRD_INSTANCES}/${encodeURIComponent(crdName)}/instances`;
  return namespace ? `${base}/${namespace}/${name}` : `${base}/${name}`;
}
