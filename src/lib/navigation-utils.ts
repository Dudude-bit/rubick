import {
  getResourceDefinition,
  ResourceType,
  toKind,
  toPlural,
  type ResourceKind,
} from "./resource-registry";

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
  // A cluster-scoped kind has no namespace to put in a path, whatever it was
  // handed: an owner reference carrying its child's namespace would turn a
  // PersistentVolume into `/persistentvolumes/default/pv`, which no route
  // matches. `isRoutableKind` refuses the mirror case — a namespaced kind
  // with no namespace — for the same reason.
  if (namespace && !isClusterScoped(resourceKind)) {
    return `/${plural}/${namespace}/${name}`;
  }
  return `/${plural}/${name}`;
}

/** Whether the registry calls this kind cluster-scoped. Unknown kinds are not. */
function isClusterScoped(kind: ResourceKind | string): boolean {
  const resolved = toKind(kind);
  return (
    resolved !== null && getResourceDefinition(resolved).scope === "cluster"
  );
}

const CRD_INSTANCES = toPlural(ResourceType.CustomResourceDefinition);

/**
 * Where one object of a CRD lives.
 *
 * A custom resource cannot be addressed the way {@link getResourceDetailUrl}
 * addresses everything else: its kind is not in the registry, so there is no
 * plural to build a path out of, and the CRD's own name — `<plural>.<group>`
 * — is the only thing that identifies the API it comes from. Hence the extra
 * argument, and hence a second function rather than a branch.
 *
 * It belongs here and not under `src/integrations/`: the route is one this
 * app serves for every CRD on any cluster, and `ResourceRef` needs it — a
 * core component cannot reach into the integrations tree.
 */
export function getCustomResourceUrl(
  crdName: string,
  name: string,
  namespace?: string | null
): string {
  const base = `/${CRD_INSTANCES}/${encodeURIComponent(crdName)}/instances`;
  return namespace ? `${base}/${namespace}/${name}` : `${base}/${name}`;
}
