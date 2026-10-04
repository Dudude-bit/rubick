import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useAttachment, type Stay } from "./attached";
import { Alert } from "@/components/ui/alert";
import { RouteLink } from "@/components/ui/route-link";
import { useAppSearch } from "@/hooks/useSearchParam";
import { useT } from "@/i18n/useT";
import { objectLink } from "@/lib/links";
import { isResourceType, toKind } from "@/lib/resource-registry";

const viaOf = (resource: string, namespace: string | undefined, name: string) =>
  [resource, namespace, name].filter(Boolean).join("/");

/**
 * Opens an attached object on its one parent, with the tab that shows it,
 * or on its own page with the reason it did not. `?view=own` is the way
 * back to the object itself, which keeps its own address throughout.
 */
export function AttachedGate({
  resource,
  namespace,
  name,
  children,
}: {
  resource: string;
  namespace?: string;
  name: string;
  children: ReactNode;
}) {
  const { view } = useAppSearch();
  const attachment = useAttachment(resource, namespace, name, view !== "own");
  if (attachment === undefined) return null;
  if (attachment.state === "parent") {
    const link = objectLink(attachment.parent, {
      tab: attachment.tab,
      via: viaOf(resource, namespace, name),
    });
    if (link) return <Navigate {...link} replace />;
  }
  return (
    <>
      {attachment.state === "stay" && <StayNote stay={attachment.stay} />}
      {children}
    </>
  );
}

function StayNote({ stay }: { stay: Stay }) {
  const t = useT();
  return (
    <Alert role="status" className="mb-3">
      {t("attached", stay.says, stay)}
    </Alert>
  );
}

/** On a parent a redirect landed on: which attached object it came from. */
export function AttachedFrom() {
  const t = useT();
  const { via } = useAppSearch();
  const parts = via?.split("/") ?? [];
  if (parts.length < 2 || parts.length > 3) return null;
  const [resource, namespace, name] =
    parts.length === 3 ? parts : [parts[0], undefined, parts[1]];
  const kind = isResourceType(resource) ? toKind(resource)! : resource;
  const own = objectLink(
    { kind, name: name!, namespace, crd: resource },
    { view: "own" }
  );
  return (
    <Alert role="status" className="mb-3">
      {t("attached", "openedFrom", { kind, name: name! })}{" "}
      {own && (
        <RouteLink {...own} className="text-info hover:underline">
          {t("attached", "openOwn")}
        </RouteLink>
      )}
    </Alert>
  );
}
