export type Theme = "light" | "dark" | "system";

const KEY = "rubick.theme";
/** The class under which a theme switch fades the colour of words and glyphs too, and for how long. */
const FADE = "theme-fade";
const FADE_MS = 200;

/**
 * The theme last applied, kept in localStorage so the first frame is
 * painted in it. The backend's setting stays the truth and replaces this
 * once it is read; until then, this is what the window looked like last.
 */
export function cachedTheme(): Theme {
  const held =
    typeof localStorage === "undefined" ? null : localStorage.getItem(KEY);
  return held === "light" || held === "dark" || held === "system"
    ? held
    : "dark";
}

/**
 * Paints the window in `theme`: the class every token hangs on, the native
 * controls' scheme, and the page background, which `index.html` sets to the
 * dark canvas so nothing is white before the stylesheet arrives.
 */
export function applyTheme(theme: Theme): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  const root = document.documentElement;
  const switching = root.classList.contains(
    resolved === "dark" ? "light" : "dark"
  );
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  if (switching) {
    root.classList.add(FADE);
    window.setTimeout(() => root.classList.remove(FADE), FADE_MS);
  }
  root.style.colorScheme = resolved;
  root.style.backgroundColor = "hsl(var(--canvas))";
  localStorage.setItem(KEY, theme);
}
