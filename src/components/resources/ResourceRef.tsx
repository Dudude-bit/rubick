import type { MouseEvent } from "react";
import { Link } from "react-router-dom";
import { CircleDashed } from "lucide-react";
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
import { useScopeTabStore } from "@/stores/scopeTabStore";
import { usePeek } from "@/hooks/usePeek";

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
  const colouring = useDisplaySettingsStore((state) => state.resourceColouring);
  const openTab = useScopeTabStore((state) => state.openTab);
  const { open } = usePeek();
  const { stem, tail } = splitName(name);
  const resolved = isResourceType(kind) ? toKind(kind) : null;
  // A kind the registry does not carry — ReplicaSet, a HelmRelease, any CRD
  // an event names — still has to reserve the mark's width, or it sits flush
  // left while every other row in the column is indented behind an icon.
  const Icon = resolved ? getResourceDefinition(resolved).icon : CircleDashed;

  // Full spends the hue on identity, so the kind falls back to its icon;
  // minimal keeps that icon hue and nothing else; off tints nothing.
  const kindStyle =
    colouring === "off"
      ? undefined
      : { color: `hsl(${kindHue(kind)} var(--kind-s) var(--kind-l))` };
  // The tint marks whichever part of the name says *which* object this is.
  // Usually that is the generated tail. But a node is `k3d-k8s-gui-dev-agent-0`
  // — every sibling shares all of it but the last few characters, and the tail
  // the splitter finds is the ordinal `-0`, two characters of colour on a
  // thirty-character string. Where the tail is that thin, or absent, the name
  // itself is the identity and the whole of it is tinted.
  const identityStyle =
    colouring === "full"
      ? { color: `hsl(${identHue(kind, name)} var(--ident-s) var(--ident-l))` }
      : undefined;
  const tailCarriesIdentity = tail.length > 2;
  const stemStyle = tailCarriesIdentity ? undefined : identityStyle;
  const tailStyle = identityStyle;
  // Dim the stem only when the tail is the tinted part; a name tinted end to
  // end must not be half grey.
  const stemClass =
    colouring === "full" && tailCarriesIdentity
      ? "text-fg-mut"
      : stemStyle
        ? undefined
        : "text-fg";
  // Minimal spends no hue on identity, so the tail falls back to being the
  // quiet half of the name — which is still more than `off`, where the whole
  // name reads at one weight.
  const tailClass =
    colouring === "full"
      ? undefined
      : colouring === "minimal"
        ? "text-fg-fnt"
        : "text-fg";

  const body = (
    <>
      <Icon
        className={cn(
          "h-2.5 w-2.5 flex-none self-center",
          colouring === "off" && "text-fg-mut"
        )}
        style={kindStyle}
        aria-hidden="true"
        data-testid="resource-ref-icon"
      />
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
          className={stemClass}
          style={stemStyle}
          data-testid="resource-ref-stem"
        >
          {stem}
        </span>
        <span
          className={tailClass}
          style={tailStyle}
          data-testid="resource-ref-tail"
        >
          {tail}
        </span>
      </span>
    </>
  );

  // No `max-w-full`: inside an inline parent that percentage resolves against
  // a width computed without the icon, which clips two characters off every
  // name in the command palette. `min-w-0` is what lets a real bound shrink it.
  const shell =
    "-mx-0.5 inline-flex min-w-0 items-baseline gap-1 rounded-[3px] px-0.5";

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
