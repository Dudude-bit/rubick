import { createFileRoute, Navigate } from "@tanstack/react-router";

import { PrintedList } from "./-components/PrintedList";
import { useCrdIndex } from "@/hooks/useCrdIndex";
import { crdInstancesLink } from "@/lib/links";

export const Route = createFileRoute("/c/$cluster/$resource/")({
  component: ResourceList,
});

/**
 * A kind with no list page of its own. A CRD's objects are on its page, with
 * its vendor's columns; every other served kind is listed as kubectl prints it.
 */
function ResourceList() {
  const { resource } = Route.useParams();
  const crds = useCrdIndex();
  const reading = resource.includes(".") && crds.isLoading;
  if (!reading && resource.includes(".") && crds.isCrd(resource))
    return <Navigate {...crdInstancesLink(resource)} replace />;
  return <PrintedList resource={resource} reading={reading} />;
}
