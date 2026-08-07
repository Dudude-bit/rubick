import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
  type ResourceKind,
} from "@/lib/resource-registry";
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { usePeek } from "@/hooks/usePeek";
import { ResourceName, RESOURCE_NAME_SHELL } from "./ResourceName";

export interface ResourceRefProps {
  kind: string;
  name: string;
  namespace?: string | null;
  /** Off where the surrounding column already says the kind. */
  showKind?: boolean;
  /**
   * Called before the peek opens on a plain left click, and before a
   * modified one opens a tab. Calling `preventDefault()` here keeps both
   * from happening; the anchor keeps its real destination either way.
   */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  className?: string;
}

/**
 * Kinds `App.tsx` serves a detail route for. The registry is deliberately not
 * the authority: it also lists Namespace and Event, which have a list route
 * and no detail route, and a CustomResourceDefinition *instance* lives under
 * `/customresourcedefinitions/:crdName/instances/...`, which cannot be built
 * from kind and name alone. Everything else here maps to `/<plural>/...`,
 * which is exactly what `getResourceDetailUrl` produces.
 */
const ROUTABLE = new Set<ResourceKind>([
  "Pod",
  "Deployment",
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

export function ResourceRef({
  kind,
  name,
  namespace,
  showKind = true,
  onClick,
  className,
}: ResourceRefProps) {
  const openTab = useScopeTabStore((state) => state.openTab);
  const { open } = usePeek();

  const body = <ResourceName kind={kind} name={name} showKind={showKind} />;

  // No `max-w-full`: inside an inline parent that percentage resolves against
  // a width computed without the icon, which clips two characters off every
  // name in the command palette. `min-w-0` is what lets a real bound shrink it.
  const shell = RESOURCE_NAME_SHELL;

  if (!isRoutableKind(kind, namespace)) {
    return <span className={cn(shell, className)}>{body}</span>;
  }

  const to = getResourceDetailUrl(kind, name, namespace);

  const openInTab = (
    event: MouseEvent<HTMLAnchorElement>,
    background: boolean
  ) => {
    // The webview has no second window to hand this to, so the modified
    // click that used to fall through to the browser opens a scope tab
    // instead — which is the same promise, kept.
    event.preventDefault();
    openTab({ href: to, background });
  };

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    // Ctrl and cmd open behind, shift opens in front: the browser rule.
    if (event.metaKey || event.ctrlKey) return openInTab(event, true);
    if (event.shiftKey) return openInTab(event, false);
    // Alt-click is the browser's save gesture; leave it alone.
    if (event.button !== 0 || event.altKey) return;
    event.preventDefault();
    open({ kind, name, namespace });
  };

  const handleAuxClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 1) return;
    onClick?.(event);
    if (event.defaultPrevented) return;
    openInTab(event, true);
  };

  return (
    <Link
      to={to}
      onClick={handleClick}
      onAuxClick={handleAuxClick}
      // The name is split across spans so the tail can carry its own hue, and
      // the accessible-name algorithm joins those spans with a space — which
      // announces "k3d-agent -0" for a pod that is called neither. Naming the
      // link outright is the only way the reader hears the real identifier.
      aria-label={`${kind} ${name}`}
      className={cn(shell, "hover:bg-hover", className)}
    >
      {body}
    </Link>
  );
}
