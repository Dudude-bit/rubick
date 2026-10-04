import { CustomResourceDetail } from "./-components/CustomResourceDetail";
import { GenericObjectPage } from "./GenericObjectPage";
import { useCrdIndex } from "@/hooks/useCrdIndex";

/**
 * Any object the address names whose kind has no page of its own. A custom
 * resource opens on its CRD's page, which knows its printer columns and its
 * vendor; every other served kind opens on the generic one.
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
  if (resource.includes(".")) {
    if (crds.isLoading) return null;
    if (crds.isCrd(resource))
      return (
        <CustomResourceDetail
          crdName={resource}
          namespace={namespace}
          name={name}
        />
      );
  }
  return (
    <GenericObjectPage resource={resource} namespace={namespace} name={name} />
  );
}
