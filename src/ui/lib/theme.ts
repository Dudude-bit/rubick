export type Theme = "light" | "dark" | "system";

const KEY = "rubick.theme";

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
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  root.style.backgroundColor = "hsl(var(--canvas))";
  localStorage.setItem(KEY, theme);
}
