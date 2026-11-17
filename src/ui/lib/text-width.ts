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
/** Enough for every label and figure a session draws; past it the cache starts again. */
const KEPT = 4096;

/**
 * JetBrains Mono's advance is 0.6 of its size for every glyph it has, so a
 * mono face's width is its length: nothing is laid out to learn it. A
 * floor over figures that change every second must not lay out the
 * document once a figure, as the flows table's did until the page hung.
 */
// ponytail: a glyph from a fallback font (CJK, emoji) is wider; names here are ASCII.
const MONO_ADVANCE: Partial<Record<TextFace, number>> = {
  mono: 7.2,
  badge: 6.6,
};

/**
 * The widths `texts` are drawn at in `face`, `null` where nothing lays text
 * out. Every one not already known is measured in a single layout.
 */
function measureAll(
  texts: readonly string[],
  face: TextFace
): (number | null)[] {
  const known = texts.map((text) => measured.get(`${face}\n${text}`) ?? null);
  const missing = [...new Set(texts.filter((_, i) => known[i] === null))];
  if (missing.length === 0 || typeof document === "undefined" || !document.body)
    return known;
  const box = document.createElement("div");
  box.style.cssText =
    "position:absolute;left:-10000px;top:0;visibility:hidden;pointer-events:none";
  const probes = missing.map((text) => {
    const probe = document.createElement("span");
    probe.className = TEXT_FACES[face];
    // Tabular figures, as everything inside a table is drawn.
    probe.style.cssText =
      "display:block;width:max-content;white-space:pre;font-variant-numeric:tabular-nums";
    probe.textContent = text;
    return probe;
  });
  box.append(...probes);
  document.body.append(box);
  const got = new Map(
    missing.map((text, i) => [text, probes[i].getBoundingClientRect().width])
  );
  box.remove();
  // A width taken in the fallback font would stay after the real one loads.
  const keep = document.fonts?.status === "loaded";
  if (keep && measured.size + missing.length > KEPT) measured.clear();
  return texts.map((text, i) => {
    if (known[i] !== null) return known[i];
    const width = got.get(text) ?? 0;
    if (width <= 0) return null;
    if (keep) measured.set(`${face}\n${text}`, width);
    return width;
  });
}

/** The width `text` is drawn at in `face`, or `null` where nothing lays text out. */
export function textWidth(text: string, face: TextFace): number | null {
  return measureAll([text], face)[0];
}

/** The widest of `texts` in `face`, at `perGlyph` a glyph where text is not laid out. */
export function widestText(
  texts: readonly string[],
  face: TextFace,
  perGlyph: number
): number {
  const advance = MONO_ADVANCE[face];
  const widths =
    advance === undefined
      ? measureAll(texts, face)
      : texts.map((text) => text.length * advance);
  return Math.ceil(
    Math.max(0, ...texts.map((text, i) => widths[i] ?? text.length * perGlyph))
  );
}
