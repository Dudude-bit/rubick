import { createFileRoute, Navigate } from "@tanstack/react-router";

import { EmptyPage } from "../../../-components/NotFound";
import { useT } from "@/i18n/useT";
import { crdInstancesLink } from "@/lib/links";
import { isResourceType } from "@/lib/resource-registry";

export const Route = createFileRoute("/c/$cluster/$resource/")({
  component: ResourceList,
});

/** A resource with no list page of its own: a CRD's objects are on its page. */
function ResourceList() {
  const t = useT();
  const { resource } = Route.useParams();
  if (resource.includes("."))
    return <Navigate {...crdInstancesLink(resource)} replace />;
  return isResourceType(resource) ? (
    <EmptyPage
      title={t("empty", "listNotShown", { resource })}
      body={t("empty", "listNotShownBody")}
    />
  ) : (
    <EmptyPage
      title={t("empty", "resourceNotOpened", { resource })}
      body={t("empty", "resourceNotOpenedBody")}
    />
  );
}
