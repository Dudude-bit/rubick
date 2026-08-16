import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  getCustomResourceUrl,
  getResourceDetailUrl,
} from "@/lib/navigation-utils";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
  type ResourceKind,
} from "@/lib/resource-registry";
import { readLinkIntent, useLinkGesture } from "@/hooks/useLinkGesture";
import { usePeek } from "@/hooks/usePeek";
import {
  ResourceName,
  RESOURCE_NAME_SHELL,
  type ResourceNameSize,
} from "./ResourceName";

export interface ResourceRefProps {
  kind: string;
  name: string;
  namespace?: string | null;
  /**
   * The CRD this object belongs to, `<plural>.<group>`, for a custom
   * resource.
   *
   * Without it a custom resource is drawn as plain text, because that is all
   * this component can honestly do: the registry has no plural for the kind,
   * so there is no address to link to and nothing to peek at. Vendor pages
   * knew the CRD all along and worked around the gap by writing their own
   * `<Link>` — which is why an Argo Application navigated away from the page
   * while the Service beside it opened a peek, and why the *managed* objects
   * in Argo's own list, which are handed to this component without one, were
   * dead text.
   */
  crd?: string;
  /** Off where the surrounding column already says the kind. */
  showKind?: boolean;
  /**
   * Draws the namespace as a dim prefix inside the reference — see
   * {@link ResourceNameProps.namespace}. On for the surfaces where the
   * namespace is what tells two same-named objects apart.
   */
  showNamespace?: boolean;
  /**
   * Called before the peek opens on a plain left click, and before a
   * modified one opens a tab. Calling `preventDefault()` here keeps both
   * from happening; the anchor keeps its real destination either way.
   */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
  size?: ResourceNameSize;
}

/**
 * Kinds `App.tsx` serves a detail route for. The registry is deliberately not
 * the authority: it also lists Namespace and Event, which have a list route
 * and no detail route, and a CustomResourceDefinition *instance* lives under
 * `/customresourcedefinitions/:crdName/instances/...`, which cannot be built
 * from kind and name alone. Everything else here maps to `/<plural>/...`,
 * which is exactly what `getResourceDetailUrl` produces.
 *
 * ReplicaSet is the mirror of Namespace and Event: a detail route and no
 * list page, because nobody browses revisions — you arrive at one from the
 * event that scaled it, a pod's owner chain or a Deployment's rollout.
 */
const ROUTABLE = new Set<ResourceKind>([
  "Pod",
  "Deployment",
  "ReplicaSet",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "ConfigMap",
  "Secret",
  "Service",
  "Ingress",
  "Endpoints",
  "PersistentVolumeClaim",
  "PersistentVolume",
  "StorageClass",
  "Node",
  "CustomResourceDefinition",
]);

/**
 * Where this object lives in the app, or `null` if it is not addressable.
 *
 * The single statement of the rule, so a caller deciding *whether* to draw a
 * reference and the component that draws one cannot disagree. A surface that
 * wraps a reference in its own layout — a row whose title is an object, say —
 * has to know the answer before it builds anything, because an element is
 * truthy however it renders and a link that returns nothing would silently
 * delete the title it was given.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function objectUrl(
  kind: string,
  name: string,
  namespace?: string | null,
  crd?: string
): string | null {
  if (crd) return getCustomResourceUrl(crd, name, namespace);
  if (!isRoutableKind(kind, namespace)) return null;
  return getResourceDetailUrl(kind, name, namespace);
}

// Callers that decide whether to offer a reference at all need this rule
// without rendering one, and it is only correct next to the component that
// enforces it — splitting it out is how the two drift apart.
// eslint-disable-next-line react-refresh/only-export-components
export function isRoutableKind(kind: string, namespace?: string | null) {
  const resolved = isResourceType(kind) ? toKind(kind) : null;
  if (!resolved || !ROUTABLE.has(resolved)) return false;
  // A namespaced kind with no namespace cannot build a valid URL, and a
  // half-built one is a dead link the user only discovers by clicking.
  return getResourceDefinition(resolved).scope !== "namespaced" || !!namespace;
}

/**
 * Where an object is, and what happens when it is clicked — with nothing said
 * about how it is drawn.
 *
 * The whole of the app's "clicking an object opens it beside what you were
 * reading" rule: the real destination on the anchor so middle-click and the
 * context menu behave, and a plain left click intercepted into a peek.
 *
 * Split out of {@link ResourceRef} because a reference is not always a name.
 * A vendor page draws `health check HTTP :8080/healthz · CDN` as the label of
 * a `BackendConfig` — that sentence *is* the useful thing about the object,
 * and rendering the object's name instead to make it clickable would be
 * trading the reader's information for the reader's ability to click. Those
 * call sites wrote their own `<Link>` and so navigated away from the page,
 * which is exactly the inconsistency this is here to end.
 *
 * `null` where the object cannot be addressed — the caller draws its own text
 * rather than an anchor to nowhere.
 */
export function ObjectLink({
  kind,
  name,
  namespace,
  crd,
  onClick,
  className,
  style,
  title,
  children,
}: Omit<ResourceRefProps, "showKind" | "size"> & {
  children: ReactNode;
  /** For a caller that positions the link itself — the routing map's nodes. */
  style?: CSSProperties;
  title?: string;
}) {
  const gesture = useLinkGesture();
  const { open } = usePeek();

  const to = objectUrl(kind, name, namespace, crd);
  if (to === null) return null;

  // This component wrote the gesture rules and then kept its own copy of
  // them; `useLinkGesture` is where they live for every other surface, so
  // ctrl-click can only mean one thing once they are read from one place.
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    // `onClick` is documented to run before the peek or before a tab. A
    // right-click opens a context menu and alt-click belongs to the
    // platform; neither is one of those, so neither wakes the callback.
    if (readLinkIntent(event) === "none") return;
    onClick?.(event);
    if (event.defaultPrevented) return;
    gesture(event, to, () => open({ kind, name, namespace, crd }));
  };

  return (
    <Link
      to={to}
      onClick={handle}
      onAuxClick={handle}
      // The name is split across spans so the tail can carry its own hue, and
      // the accessible-name algorithm joins those spans with a space — which
      // announces "k3d-agent -0" for a pod that is called neither. Naming the
      // link outright is the only way the reader hears the real identifier.
      aria-label={`${kind} ${name}`}
      className={className}
      style={style}
      title={title}
    >
      {children}
    </Link>
  );
}

export function ResourceRef({
  kind,
  name,
  namespace,
  crd,
  showKind = true,
  showNamespace = false,
  onClick,
  className,
  size,
}: ResourceRefProps) {
  const body = (
    <ResourceName
      kind={kind}
      name={name}
      namespace={showNamespace ? namespace : undefined}
      showKind={showKind}
      size={size}
    />
  );

  // No `max-w-full`: inside an inline parent that percentage resolves against
  // a width computed without the icon, which clips two characters off every
  // name in the command palette. `min-w-0` is what lets a real bound shrink it.
  const shell = RESOURCE_NAME_SHELL;

  // Asked here rather than left to `ObjectLink` returning null: an element is
  // truthy whatever it renders, so the fallback has to be chosen before one
  // is built.
  if (objectUrl(kind, name, namespace, crd) === null) {
    return <span className={cn(shell, className)}>{body}</span>;
  }

  return (
    <ObjectLink
      kind={kind}
      name={name}
      namespace={namespace}
      crd={crd}
      onClick={onClick}
      className={cn(shell, "hover:bg-hover", className)}
    >
      {body}
    </ObjectLink>
  );
}
