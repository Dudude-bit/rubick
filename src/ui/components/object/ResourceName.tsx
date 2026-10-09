import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { KindIcon } from "./KindIcon";
import { splitName, identHue, kindHue } from "@/lib/resource-identity";
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
// oxlint-disable-next-line react-refresh/only-export-components
export const RESOURCE_NAME_SIZE: Record<ResourceNameSize, string> = {
  row: "text-xs",
  title: "text-[13px]",
};

export interface ResourceNameProps {
  kind: string;
  name: string;
  /**
   * Drawn as a dim `namespace/` prefix inside the name's own box, never cut,
   * so it highlights with the name instead of wrapping beside it as a loose
   * word. For the surfaces where two objects wear one name and the namespace
   * is the identity; most columns already say it and pass nothing.
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

/** A pod's own suffix is five characters, so a cut generated name keeps at least its last five. */
const END_CHARS = 5;
/** Turns a shortfall of any fraction of a pixel into a whole width. */
const STEP = 9999;
/** The half pixel the stylesheet forgives, in characters of the row size. */
const SLACK = 0.07;

/** A width as CSS resolved against the name's box, and the same width worked out for a box `w` characters wide. */
export interface Width {
  css: string;
  at: (w: number) => number;
}

const chars = (n: number): Width => ({ css: `${n}ch`, at: () => n });
const less = (a: Width, n: number): Width => ({
  css: `${a.css} - ${n}ch`,
  at: (w) => a.at(w) - n,
});
const roomAfter = (n: number): Width => ({
  css: `round(down, 100% - ${n}ch, 1ch)`,
  at: (w) => Math.floor(w - n),
});
const clamp = (lo: Width, value: Width, hi: Width): Width => ({
  css: `clamp(${lo.css}, ${value.css}, ${hi.css})`,
  at: (w) => Math.max(lo.at(w), Math.min(value.at(w), hi.at(w))),
});
const larger = (a: Width, b: Width): Width => ({
  css: `max(${a.css}, ${b.css})`,
  at: (w) => Math.max(a.at(w), b.at(w)),
});
/** `then` while the box holds `need` characters, nothing once it does not. */
const fitting = (need: number, then: Width): Width => ({
  css: `clamp(0px, (100% - ${need}ch + 0.5px) * ${STEP}, ${then.css})`,
  at: (w) => (w + SLACK >= need ? Math.max(0, then.at(w)) : 0),
});
/** `then` once the box is short of `need` characters, nothing while it is not. */
const short = (need: number, then: Width): Width => ({
  css: `clamp(0px, (${need}ch - 100% - 0.5px) * ${STEP}, ${then.css})`,
  at: (w) => (w + SLACK < need ? Math.max(0, then.at(w)) : 0),
});

export interface NameCut {
  box: number;
  label: Width;
  head: Width;
  cut: Width;
  end: Width | null;
}

/**
 * The width of each part of a name too long for its box, in whole characters
 * of the mono face: the kind label whole or gone, the start of the name up to
 * its generated segments, one ellipsis, and the end of the name. Whole
 * characters on both sides of the ellipsis keep a gap from opening beside it.
 */
// oxlint-disable-next-line react-refresh/only-export-components
export function nameCut({
  name,
  stem,
  generated,
  before,
  label,
}: {
  name: string;
  stem: string;
  generated: boolean;
  /** Characters drawn ahead of the name that are never cut. */
  before: number;
  /** Characters of the kind label, dropped whole where the name needs them. */
  label: number;
}): NameCut {
  const whole = before + name.length;
  const room = roomAfter(before);
  const keepEnd = generated ? Math.min(END_CHARS, name.length - 1) : 0;
  const prefer = generated ? stem.length : name.length;
  const head = clamp(
    chars(Math.min(3, prefer)),
    less(room, keepEnd + 1),
    chars(prefer)
  );
  return {
    box: whole + label,
    label: fitting(whole + label, chars(label)),
    head: larger(head, fitting(whole, chars(name.length))),
    cut: short(whole, chars(1)),
    end: generated
      ? short(whole, {
          css: `${room.css} - ${head.css} - 1ch`,
          at: (w) => room.at(w) - head.at(w) - 1,
        })
      : null,
  };
}

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
  const identity =
    colouring === "full"
      ? `hsl(${identHue(kind, name)} var(--ident-s) var(--ident-l))`
      : undefined;
  const identityStyle = identity ? { color: identity } : undefined;
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
  const widths = nameCut({
    name,
    stem,
    generated: tail !== "",
    before: namespace ? namespace.length + 1 : 0,
    label: showKind ? kind.length + 1 : 0,
  });

  return (
    <>
      <KindIcon
        kind={kind}
        className={cn("h-2.5 w-2.5 self-center", iconClassName)}
        data-testid="resource-ref-icon"
      />
      <span
        className={cn(
          "flex min-w-0 max-w-full overflow-hidden whitespace-nowrap font-mono",
          RESOURCE_NAME_SIZE[size]
        )}
        style={{ width: `${widths.box}ch` }}
        data-testid="resource-ref-name"
        onMouseEnter={(event) => {
          const box = event.currentTarget;
          box.title = [...box.children].some(
            (part) =>
              !part.hasAttribute("aria-hidden") &&
              part.scrollWidth > part.clientWidth
          )
            ? `${namespace ? `${namespace}/` : ""}${showKind ? `${kind}/` : ""}${name}`
            : "";
        }}
      >
        {namespace && (
          <span
            className="flex-none text-fg-fnt"
            data-testid="resource-ref-namespace"
          >
            {namespace}/
          </span>
        )}
        {showKind && (
          <span
            className="flex-none overflow-hidden"
            style={{ width: widths.label.css }}
            data-testid="resource-ref-label"
          >
            <span
              className={cn(colouring !== "full" && "text-fg-mut")}
              style={colouring === "full" ? kindStyle : undefined}
              data-testid="resource-ref-kind"
            >
              {kind}
            </span>
            <span className="text-fg-fnt">/</span>
          </span>
        )}
        <span
          className="flex-none overflow-hidden"
          style={{ width: widths.head.css }}
          data-testid="resource-ref-head"
        >
          {/* The kind reaches a screen reader either way — when it is shown as
            an icon only, the text still has to name it. */}
          {!showKind && <span className="sr-only">{kind} </span>}
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
        <span
          aria-hidden="true"
          className="flex-none overflow-hidden text-fg-fnt before:content-['…']"
          style={{ width: widths.cut.css }}
          data-testid="resource-ref-cut"
        />
        {widths.end && (
          // Drawn by the stylesheet, so the name is in the text once: a reader,
          // a copy and a search each find it whole in the head.
          <span
            aria-hidden="true"
            className="flex-none overflow-hidden [direction:rtl]"
            style={{ width: widths.end.css }}
            data-testid="resource-ref-end"
          >
            <span
              dir="ltr"
              data-stem={stem}
              data-tail={tail}
              className={cn(
                "before:content-[attr(data-stem)] after:content-[attr(data-tail)]",
                stemStyle
                  ? "before:text-[color:var(--ident)]"
                  : stemClass === "text-fg-mut"
                    ? "before:text-fg-mut"
                    : "before:text-fg",
                tailStyle
                  ? "after:text-[color:var(--ident)]"
                  : tailClass === "text-fg-fnt"
                    ? "after:text-fg-fnt"
                    : "after:text-fg"
              )}
              style={
                identity
                  ? ({ "--ident": identity } as CSSProperties)
                  : undefined
              }
            />
          </span>
        )}
      </span>
    </>
  );
}
