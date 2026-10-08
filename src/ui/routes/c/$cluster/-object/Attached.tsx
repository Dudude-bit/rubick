import { Navigate } from "@tanstack/react-router";
import {
  ArrowUpRight,
  CornerDownRight,
  EyeOff,
  Info,
  Swords,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { ownView, useAttachment, type Stay } from "./attachment";
import { servedOf, useServed } from "./served";
import { ResourceRef } from "@/components/object/ResourceRef";
import { Alert } from "@/components/ui/alert";
import { RouteLink } from "@/components/ui/route-link";
import { useAppSearch } from "@/hooks/useSearchParam";
import { parts } from "@/i18n/parts";
import { useT } from "@/i18n/useT";
import { objectLink } from "@/lib/links";
import { isResourceType, toKind } from "@/lib/resource-registry";
import { cn } from "@/lib/utils";

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
      view: ownView(attachment.parent),
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

/** Why an object stayed on its own page, drawn: every reason has its mark. */
const STAY: Record<
  Stay["says"],
  { icon: LucideIcon; tone: string; rule: string }
> = {
  targetMissing: { icon: Unlink, tone: "text-warn", rule: "border-warn" },
  targetUnread: { icon: EyeOff, tone: "text-warn", rule: "border-warn" },
  targetContested: { icon: Swords, tone: "text-err", rule: "border-err" },
  siblingsUnread: { icon: EyeOff, tone: "text-warn", rule: "border-warn" },
  noService: { icon: Info, tone: "text-info", rule: "border-info" },
  noOwner: { icon: Info, tone: "text-info", rule: "border-info" },
  involvedGone: { icon: Unlink, tone: "text-warn", rule: "border-warn" },
};

function StayNote({ stay }: { stay: Stay }) {
  const t = useT();
  const look = STAY[stay.says];
  const Icon = look.icon;
  return (
    <Alert role="status" className={cn("mb-3", look.rule)}>
      <Icon className={look.tone} />
      <span>{t("attached", stay.says, stay)}</span>
    </Alert>
  );
}

/** On a parent a redirect landed on: which attached object it came from. */
export function AttachedFrom() {
  const { via } = useAppSearch();
  const segments = via?.split("/") ?? [];
  if (segments.length < 2 || segments.length > 3) return null;
  return (
    <OpenedFrom
      resource={segments[0]}
      namespace={segments.length === 3 ? segments[1] : undefined}
      name={segments[segments.length - 1]}
    />
  );
}

function OpenedFrom({
  resource,
  namespace,
  name,
}: {
  resource: string;
  namespace?: string;
  name: string;
}) {
  const t = useT();
  const served = useServed(servedOf(resource));
  const kind =
    served.state === "served"
      ? served.entry.kind
      : isResourceType(resource)
        ? toKind(resource)!
        : resource;
  const crd = isResourceType(resource) ? undefined : resource;
  const own = objectLink({ kind, name, namespace, crd }, { view: "own" });
  return (
    <Alert role="status" className="mb-3 border-info">
      <CornerDownRight className="text-info" />
      <span>
        {parts(t("attached", "openedFrom"), {
          object: (
            <ResourceRef
              kind={kind}
              name={name}
              namespace={namespace}
              crd={crd}
            />
          ),
        })}
        {own && (
          <RouteLink
            {...own}
            className="ml-2 inline-flex items-center gap-0.5 whitespace-nowrap text-info hover:underline"
          >
            {t("attached", "openOwn")}
            <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
          </RouteLink>
        )}
      </span>
    </Alert>
  );
}
