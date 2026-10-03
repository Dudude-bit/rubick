import { EmptyPage } from "@/components/layout/NotFound";
import { CustomResourceDetail } from "@/pages/CustomResourceDetail";
import { useT } from "@/i18n/useT";
import { isResourceType, toKind } from "@/lib/resource-registry";
import { GenericObjectPage } from "./GenericObjectPage";

/**
 * Any object the address names whose kind has no page of its own: a custom
 * resource by its CRD's name, or a kind the registry knows and the app has
 * not drawn a screen for. Anything else is said to be unknown, not missing.
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
  const t = useT();
  if (resource.includes("."))
    return (
      <CustomResourceDetail
        crdName={resource}
        namespace={namespace}
        name={name}
      />
    );
  const kind = isResourceType(resource) ? toKind(resource) : null;
  if (kind)
    return <GenericObjectPage kind={kind} namespace={namespace} name={name} />;
  return (
    <EmptyPage
      title={t("empty", "resourceNotOpened", { resource })}
      body={t("empty", "resourceNotOpenedBody")}
    />
  );
}
