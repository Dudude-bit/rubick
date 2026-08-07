import { CircleDashed } from "lucide-react";

import { cn } from "@/lib/utils";
import { splitName, identHue, kindHue } from "@/lib/resource-identity";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "@/lib/resource-registry";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";

/**
 * A resource's kind glyph and its tinted name, with nothing said about where
 * it leads.
 *
 * Split out of `ResourceRef` because the detail page's own `<h1>` is the one
 * place in the app that shows a resource name and must *not* be a link to
 * itself — and, rendering it by hand, was the one place the name was plain
 * text. A name that carries its hue in every list and loses it on its own
 * page teaches the reader that the hue means "clickable" rather than "this
 * object", which is the opposite of what identity colouring is for.
 *
 * Returns a fragment: the caller owns the box, because a table cell, a
 * command-palette row and a page title need different ones.
 */
export interface ResourceNameProps {
  kind: string;
  name: string;
  /** Off where the surrounding column, or the breadcrumb, already says it. */
  showKind?: boolean;
  /** Sized up where the name is a heading rather than a row. */
  iconClassName?: string;
}

/** The box the parts expect: baseline-aligned, shrinkable, one gap. */
export const RESOURCE_NAME_SHELL =
  "-mx-0.5 inline-flex min-w-0 items-baseline gap-1 rounded-[3px] px-0.5";

export function ResourceName({
  kind,
  name,
  showKind = true,
  iconClassName,
}: ResourceNameProps) {
  const colouring = useDisplaySettingsStore((state) => state.resourceColouring);
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

  return (
    <>
      <Icon
        className={cn(
          "h-2.5 w-2.5 flex-none self-center",
          colouring === "off" && "text-fg-mut",
          iconClassName
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
}
