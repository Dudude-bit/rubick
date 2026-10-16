/** The faces a floor is measured in, with the classes the headers and cells draw them in. */
export const TEXT_FACES = {
  header: "text-[11px] font-medium",
  badge: "font-mono text-[11px] font-medium",
  mono: "font-mono text-xs",
  sans: "text-xs",
  caption: "text-[11px]",
} as const;

export type TextFace = keyof typeof TEXT_FACES;

const measured = new Map<string, number>();

/** The width `text` is drawn at in `face`, or `null` where nothing lays text out. */
export function textWidth(text: string, face: TextFace): number | null {
  const key = `${face}\n${text}`;
  const known = measured.get(key);
  if (known !== undefined) return known;
  if (typeof document === "undefined" || !document.body) return null;
  const probe = document.createElement("span");
  probe.className = TEXT_FACES[face];
  // Tabular figures, as everything inside a table is drawn.
  probe.style.cssText =
    "position:absolute;left:-10000px;top:0;visibility:hidden;white-space:pre;font-variant-numeric:tabular-nums";
  probe.textContent = text;
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  if (width <= 0) return null;
  // A width taken in the fallback font would stay after the real one loads.
  if (document.fonts?.status === "loaded") measured.set(key, width);
  return width;
}

/** The widest of `texts` in `face`, at `perGlyph` a glyph where text is not laid out. */
export function widestText(
  texts: readonly string[],
  face: TextFace,
  perGlyph: number
): number {
  return Math.ceil(
    Math.max(
      0,
      ...texts.map((text) => textWidth(text, face) ?? text.length * perGlyph)
    )
  );
}
