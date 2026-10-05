import type { CSSProperties, MouseEvent, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  crdFor,
  hrefOf,
  objectLink,
  type ObjectLinkOptions,
} from "@/lib/links";
import { readLinkIntent, useLinkGesture } from "@/hooks/useLinkGesture";
import { usePeek } from "@/hooks/usePeek";
import { useObjectMenuStore } from "@/stores/objectMenuStore";
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
   * so there is no address to link to and nothing to peek at. Pass it
   * wherever the call site knows it rather than writing a `<Link>` of your
   * own — that navigates away from the page instead of opening a peek.
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
  /** Where the anchor goes, for a reference to the object being looked at. */
  linkOptions?: ObjectLinkOptions;
}

/**
 * Where an object is, and what happens when it is clicked — with nothing said
 * about how it is drawn.
 *
 * The whole of the app's "clicking an object opens it beside what you were
 * reading" rule: the real destination on the anchor so middle-click and the
 * context menu behave, and a plain left click intercepted into a peek.
 *
 * Separate from {@link ResourceRef} because a reference is not always a name.
 * A vendor page draws `health check HTTP :8080/healthz · CDN` as the label of
 * a `BackendConfig` — that sentence *is* the useful thing about the object,
 * and rendering the object's name instead to make it clickable would trade
 * the reader's information for the reader's ability to click.
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
  linkOptions,
  children,
}: Omit<ResourceRefProps, "showKind" | "size"> & {
  children: ReactNode;
  /** For a caller that positions the link itself — the routing map's nodes. */
  style?: CSSProperties;
  title?: string;
}) {
  const gesture = useLinkGesture();
  const { open } = usePeek();

  const link = objectLink({ kind, name, namespace, crd }, linkOptions);
  if (link === null) return null;

  // The gesture rules live in `useLinkGesture` for every surface; a local
  // copy is how ctrl-click comes to mean two different things.
  const handle = (event: MouseEvent<HTMLAnchorElement>) => {
    // `onClick` is documented to run before the peek or before a tab. A
    // right-click opens a context menu and alt-click belongs to the
    // platform; neither is one of those, so neither wakes the callback.
    if (readLinkIntent(event) === "none") return;
    onClick?.(event);
    if (event.defaultPrevented) return;
    gesture(event, hrefOf(link), () =>
      open({ kind, name, namespace, crd: crdFor({ kind, name, crd }) })
    );
  };

  return (
    <Link
      {...link}
      onClick={handle}
      onAuxClick={handle}
      onContextMenu={(event) => {
        event.preventDefault();
        useObjectMenuStore.getState().open({
          name,
          to: hrefOf(link),
          x: event.clientX,
          y: event.clientY,
        });
      }}
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
  linkOptions,
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

  // Asked before anything is built: an element is truthy whatever it renders,
  // so `ObjectLink` returning null cannot choose the fallback.
  if (objectLink({ kind, name, namespace, crd }) === null) {
    // Named for the same reason the link is: the name is drawn as two boxes
    // so the tail can keep its hue and its place, and the accessible-name
    // algorithm joins those with a space — "k3d-agent -0" for a pod called
    // neither. Said in a hidden span rather than with `aria-label`, which a
    // bare span is role=generic for and where ARIA prohibits naming: the
    // label was dropped and the concatenation announced anyway.
    return (
      <span className={cn(shell, className)}>
        <span className="sr-only">{`${kind} ${name}`}</span>
        <span aria-hidden="true" className="contents">
          {body}
        </span>
      </span>
    );
  }

  return (
    <ObjectLink
      kind={kind}
      name={name}
      namespace={namespace}
      crd={crd}
      onClick={onClick}
      linkOptions={linkOptions}
      className={cn(shell, "hover:bg-hover", className)}
    >
      {body}
    </ObjectLink>
  );
}
