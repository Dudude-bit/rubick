import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { splitName, identHue, kindHue } from "@/lib/resource-identity";
import { getResourceDetailUrl } from "@/lib/navigation-utils";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
  type ResourceKind,
} from "@/lib/resource-registry";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

export interface ResourceRefProps {
  kind: string;
  name: string;
  namespace?: string | null;
  /** Off where the surrounding column already says the kind. */
  showKind?: boolean;
  /**
   * Called before navigation on a plain left click. The peek panel takes this
   * seam and calls `preventDefault()`; the anchor keeps its real destination
   * either way, so middle-click and modifier-click still open the page.
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
  const colouring = useDisplaySettingsStore((state) => state.resourceColouring);
  const { stem, tail } = splitName(name);
  const resolved = isResourceType(kind) ? toKind(kind) : null;
  const Icon = resolved ? getResourceDefinition(resolved).icon : null;

  // Full spends the hue on identity, so the kind falls back to its icon;
  // minimal keeps that icon hue and nothing else; off tints nothing.
  const kindStyle =
    colouring === "off"
      ? undefined
      : { color: `hsl(${kindHue(kind)} var(--kind-s) var(--kind-l))` };
  const tinted = colouring === "full" && tail !== "";
  const tailStyle = tinted
    ? { color: `hsl(${identHue(kind, name)} var(--ident-s) var(--ident-l))` }
    : undefined;

  const body = (
    <>
      {Icon && (
        <Icon
          className={cn(
            "h-2.5 w-2.5 flex-none self-center",
            colouring === "off" && "text-fg-mut"
          )}
          style={kindStyle}
          aria-hidden="true"
          data-testid="resource-ref-icon"
        />
      )}
      <span className="truncate font-mono">
        {/* The kind reaches a screen reader either way — when it is shown as
            an icon only, the text still has to name it. */}
        {showKind ? (
          <>
            <span
              className={cn(colouring !== "full" && "text-fg-mut")}
              style={colouring === "full" ? kindStyle : undefined}
              data-testid="resource-ref-kind"
            >
              {kind}
            </span>
            <span className="text-fg-fnt">/</span>
          </>
        ) : (
          <span className="sr-only">{kind} </span>
        )}
        <span
          // Only worth dimming when the tail is actually carrying the identity;
          // a name with no generated tail would otherwise read dim end to end.
          className={cn(tinted ? "text-fg-mut" : "text-fg")}
          data-testid="resource-ref-stem"
        >
          {stem}
        </span>
        <span
          className={cn(
            colouring === "off" ? "text-fg" : !tinted && "text-fg-fnt"
          )}
          style={tailStyle}
          data-testid="resource-ref-tail"
        >
          {tail}
        </span>
      </span>
    </>
  );

  const shell =
    "-mx-0.5 inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-[3px] px-0.5";

  if (!isRoutableKind(kind, namespace)) {
    return <span className={cn(shell, className)}>{body}</span>;
  }

  return (
    <Link
      to={getResourceDetailUrl(kind, name, namespace)}
      onClick={onClick}
      className={cn(shell, "hover:bg-hover", className)}
    >
      {body}
    </Link>
  );
}
