/** Used only if `--canvas` cannot be read; matches the dark canvas token. */
const CANVAS_FALLBACK = "rgb(26, 28, 30)";

/**
 * The canvas colour and the sixteen ANSI slots, as literals xterm can parse.
 *
 * xterm needs a colour string, not a class, so the terminal cannot inherit
 * `bg-canvas` and used to hardcode a bluish `#1a1a2e` that read as a panel
 * floating on the page. Reading the token keeps it exactly the page colour.
 * The tokens are resolved through probe elements rather than passed as
 * `hsl(...)` because xterm parses `#rrggbb` and `rgb()` directly and hands
 * anything else to a canvas 2D context it may fail to acquire.
 *
 * **One probe per colour, and never one probe reused.** Overwriting an
 * element's inline `color` and reading it straight back answers with the
 * value the element had the first time it was asked — the inline style is
 * the new colour and the computed style is the old one. A single probe
 * therefore handed out the canvas colour seventeen times: every ANSI slot
 * became the background, and a shell that printed in colour printed
 * nothing anybody could see.
 */
export function readCanvasTheme(): {
  background: string;
  dark: boolean;
  ansi: string[];
} {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const style = getComputedStyle(root);
  const token = style.getPropertyValue("--canvas").trim();
  const slots = Array.from({ length: 16 }, (_, i) =>
    style.getPropertyValue(`--ansi-${i}`).trim()
  );
  if (!token) return { background: CANVAS_FALLBACK, dark, ansi: [] };

  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;visibility:hidden";
  const probes = [token, ...slots].map((hsl) => {
    const probe = document.createElement("span");
    if (hsl) probe.style.color = `hsl(${hsl})`;
    holder.appendChild(probe);
    return { hsl, probe };
  });
  document.body.appendChild(holder);
  const [background, ...ansi] = probes.map(({ hsl, probe }) =>
    hsl ? getComputedStyle(probe).color : ""
  );
  holder.remove();

  return {
    background: background || CANVAS_FALLBACK,
    dark,
    // A palette every slot of which is the background is not a palette, it
    // is the failure above wearing sixteen hats. Handing xterm none of them
    // leaves it its own, which is wrong in a readable way.
    ansi:
      ansi.every(Boolean) && ansi.some((colour) => colour !== background)
        ? ansi
        : [],
  };
}
