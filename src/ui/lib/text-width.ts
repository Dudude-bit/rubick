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

/**
 * Where probes are laid out: kept in the document, off screen, and walled
 * off with `contain: strict`, so reading a probe lays out the shelf and
 * not the page. A probe put on the body cost a layout of the window for
 * each string: the first open of Cost forced 323 of them, 3345 at its cap.
 */
let shelf: HTMLElement | null = null;

function shelfOf(): HTMLElement {
  if (shelf?.isConnected) return shelf;
  shelf = document.createElement("div");
  shelf.setAttribute("aria-hidden", "true");
  shelf.style.cssText =
    "position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;contain:strict";
  document.body.append(shelf);
  return shelf;
}

/**
 * Figures are tabular wherever text is measured, so every digit is as wide
 * as `0`: "0.00167 EUR" and "0.00523 EUR" are one shape, measured once.
 */
const shapeOf = (text: string) => text.replace(/[0-9]/g, "0");

/**
 * The widths `texts` are drawn at in `face`, `null` where nothing lays text
 * out. What is not known yet is laid out at once: one layout for the lot.
 */
export function textWidths(
  texts: readonly string[],
  face: TextFace
): (number | null)[] {
  const keyOf = (shape: string) => `${face}\n${shape}`;
  const shapes = texts.map(shapeOf);
  const unknown = [...new Set(shapes)].filter((s) => !measured.has(keyOf(s)));
  const fresh = new Map<string, number | null>();
  if (unknown.length > 0 && typeof document !== "undefined" && document.body) {
    const probes = unknown.map((text) => {
      const probe = document.createElement("span");
      probe.className = TEXT_FACES[face];
      // Tabular figures, as everything inside a table is drawn.
      probe.style.cssText =
        "position:absolute;width:max-content;white-space:pre;font-variant-numeric:tabular-nums";
      probe.textContent = text;
      return probe;
    });
    const at = shelfOf();
    at.append(...probes);
    // A width taken in the fallback font would stay after the real one loads.
    const keep = document.fonts?.status === "loaded";
    probes.forEach((probe, i) => {
      const width = probe.getBoundingClientRect().width;
      fresh.set(unknown[i]!, width > 0 ? width : null);
      if (keep && width > 0) measured.set(keyOf(unknown[i]!), width);
    });
    for (const probe of probes) probe.remove();
  }
  return shapes.map(
    (shape) => measured.get(keyOf(shape)) ?? fresh.get(shape) ?? null
  );
}

/** The width `text` is drawn at in `face`, or `null` where nothing lays text out. */
export function textWidth(text: string, face: TextFace): number | null {
  return textWidths([text], face)[0] ?? null;
}

/** The widest of `texts` in `face`, at `perGlyph` a glyph where text is not laid out. */
export function widestText(
  texts: readonly string[],
  face: TextFace,
  perGlyph: number
): number {
  const widths = textWidths(texts, face);
  let widest = 0;
  texts.forEach((text, i) => {
    widest = Math.max(widest, widths[i] ?? text.length * perGlyph);
  });
  return Math.ceil(widest);
}
