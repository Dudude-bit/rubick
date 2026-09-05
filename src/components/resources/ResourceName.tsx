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
 * Separate from `ResourceRef` so the detail page's own `<h1>` — the one place
 * that shows a resource name and must *not* be a link to itself — still gets
 * the hue. A name that carries its hue in every list and loses it on its own
 * page teaches the reader that the hue means "clickable" rather than "this
 * object", which is the opposite of what identity colouring is for.
 *
 * Returns a fragment: the caller owns the box, because a table cell, a
 * command-palette row and a page title need different ones.
 */
/**
 * How large a reference draws itself. A reference inherits no size from
 * whichever ancestor happens to set one; a caller names one of these two.
 */
export type ResourceNameSize = "row" | "title";

/**
 * `row` is the app's reading size for a line of content — what tables,
 * key/value values, event rows and child rows already set for themselves. The
 * 11px clauses beside a name are qualifiers; the name is the subject of the
 * line, and one step above its qualifiers is all the hierarchy it needs.
 *
 * `title` is a heading: a detail page's own `<h1>`, and the peek's header.
 *
 * There is no third size, and no per-call-site override. Mono is not stepped
 * down against the sans either: measured in the app's own engine, JetBrains
 * Mono and Inter have an identical cap-height ratio (0.7344) and x-heights
 * within 2.9% (0.5625 vs 0.5469), so at these sizes they rasterise to the
 * same cap and x-height to the pixel. Mono only looks large because of its
 * fixed advance — 22% more width for the same string — and shrinking the type
 * to buy that width back would drop the name below the baseline rhythm it
 * shares with the sans beside it.
 */
// Kept beside the component that applies it: a scale in its own module drifts
// from its only user.
// eslint-disable-next-line react-refresh/only-export-components
export const RESOURCE_NAME_SIZE: Record<ResourceNameSize, string> = {
  row: "text-xs",
  title: "text-[13px]",
};

export interface ResourceNameProps {
  kind: string;
  name: string;
  /**
   * Drawn as a dim `namespace/` prefix inside the name's own box, so it
   * truncates and highlights with the name instead of wrapping beside it
   * as a loose word. For the surfaces where two objects wear one name and
   * the namespace is the identity; most columns already say it and pass
   * nothing.
   */
  namespace?: string | null;
  /** Off where the surrounding column, or the breadcrumb, already says it. */
  showKind?: boolean;
  /** Sized up where the name is a heading rather than a row. */
  iconClassName?: string;
  size?: ResourceNameSize;
}

/** The box the parts expect: baseline-aligned, shrinkable, one gap. */
export const RESOURCE_NAME_SHELL =
  "-mx-0.5 inline-flex min-w-0 items-baseline gap-1 rounded-[3px] px-0.5";

export function ResourceName({
  kind,
  name,
  namespace,
  showKind = true,
  iconClassName,
  size = "row",
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
  // The tint marks whichever part of the name says *which* object this is,
  // usually the generated tail. But a node is `k3d-k8s-gui-dev-agent-0`, where
  // the tail the splitter finds is the ordinal `-0` — two characters of colour
  // on a thirty-character string. Where the tail is that thin, or absent, the
  // name itself is the identity and the whole of it is tinted.
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
      <span
        className={cn("truncate font-mono", RESOURCE_NAME_SIZE[size])}
        data-testid="resource-ref-name"
      >
        {namespace && (
          <span className="text-fg-fnt" data-testid="resource-ref-namespace">
            {namespace}/
          </span>
        )}
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
