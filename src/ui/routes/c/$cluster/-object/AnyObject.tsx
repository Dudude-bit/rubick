import { Navigate } from "@tanstack/react-router";

import { AttachedGate } from "./Attached";
import { CustomResourceDetail } from "./-components/CustomResourceDetail";
import { GenericObjectPage } from "./GenericObjectPage";
import { segmentNamespaced, servedOf, useServed } from "./served";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { namespaceListLink } from "@/lib/links";

/**
 * Any object the address names whose kind has no page of its own. A custom
 * resource opens on its CRD's page, which knows its printer columns and its
 * vendor; every other served kind opens on the generic one. Either may
 * belong to a parent and open there instead.
 */
export function AnyObject({
  resource,
  namespace,
  name,
}: {
  resource: string;
  namespace?: string;
  name: string;
}) {
  const crds = useCrdIndex();
  const namespaced = segmentNamespaced(resource, useServed(servedOf(resource)));
  // Without a namespace, a namespaced kind's one segment names a namespace.
  if (namespace === undefined && namespaced !== false)
    return namespaced ? (
      <Navigate {...namespaceListLink(resource, name)} replace />
    ) : null;
  if (resource.includes(".") && crds.isLoading) return null;
  const page =
    resource.includes(".") && crds.isCrd(resource) ? (
      <CustomResourceDetail
        crdName={resource}
        namespace={namespace}
        name={name}
      />
    ) : (
      <GenericObjectPage
        resource={resource}
        namespace={namespace}
        name={name}
      />
    );
  return (
    <AttachedGate resource={resource} namespace={namespace} name={name}>
      {page}
    </AttachedGate>
  );
}
