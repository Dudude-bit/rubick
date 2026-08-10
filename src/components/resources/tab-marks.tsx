/**
 * What a tab wears: the glyph that says what it is, and the mark it earned.
 *
 * `detail-tab.ts` states both as rules, and neither depends on the strip the
 * tab sits in. A detail page draws an underline strip and the peek draws a
 * pill row — deliberately different, because they are different places — but
 * a tab that opens onto Pods is the same tab in both, so it is drawn here
 * once and both ask for it.
 */
import { CircleDashed } from "lucide-react";

import { kindHue } from "@/lib/resource-identity";
import {
  getResourceDefinition,
  isResourceType,
  toKind,
} from "@/lib/resource-registry";
import { cn } from "@/lib/utils";
import { useDisplaySettingsStore } from "@/stores/displaySettingsStore";
import type { DetailTabGlyph, DetailTabMark } from "./detail-tab";

/** 5px, which is the smallest disc that still reads as round rather than as dirt. */
const DOT = "h-[5px] w-[5px] flex-none rounded-full";

/**
 * A mark, and the words it stands for.
 *
 * Colour never carries it alone. The dot sits beside a label that changed,
 * and `says` reaches the accessible name — "Containers — 1 of 4 failing" —
 * because a red disc is nothing at all to a reader who cannot see red.
 */
export function TabMark({
  mark,
  isActive,
}: {
  mark: DetailTabMark;
  isActive: boolean;
}) {
  if (mark.shows === "count") {
    return (
      <span
        className={cn(
          "flex-none text-[11px] tabular-nums",
          isActive ? "text-fg-mut" : "text-fg-fnt"
        )}
      >
        {mark.of}
      </span>
    );
  }
  if (mark.shows === "severity") {
    return (
      <span
        aria-hidden="true"
        className={cn(DOT, mark.tone === "err" ? "bg-err" : "bg-warn")}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(DOT, "animate-tab-live bg-ok motion-reduce:animate-none")}
    />
  );
}

/**
 * The hue is read from the same `kindHue` the sidebar and every reference
 * use, and honours the colouring setting for the same reason they do: a
 * reader who turned identity colour off did not ask for one strip to keep it.
 */
export function TabGlyph({
  glyph,
  isActive,
}: {
  glyph: DetailTabGlyph;
  isActive: boolean;
}) {
  const colouring = useDisplaySettingsStore((state) => state.resourceColouring);
  const tinted = colouring !== "off";

  const resolved =
    glyph.names === "kind" && isResourceType(glyph.kind)
      ? toKind(glyph.kind)
      : null;
  // A kind the registry does not carry — a CRD's own kind, on its Instances
  // tab — gets the same dashed circle it gets in every list of them.
  const Icon =
    glyph.names === "view"
      ? glyph.icon
      : resolved
        ? getResourceDefinition(resolved).icon
        : CircleDashed;
  const hue = glyph.names === "view" || !tinted ? null : kindHue(glyph.kind);

  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "h-3.5 w-3.5 flex-none",
        hue === null &&
          (isActive ? "text-fg" : "text-fg-fnt group-hover:text-fg-mut")
      )}
      style={
        hue === null
          ? undefined
          : { color: `hsl(${hue} var(--kind-s) var(--kind-l))` }
      }
    />
  );
}
