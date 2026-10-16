/**
 * WebKitGTK matches no :focus-visible after a click, later Tab presses
 * included, so index.css also rings :focus while this attribute is set.
 */

export const KEYS_ATTRIBUTE = "data-keys";

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

export function startFocusModality(
  root: HTMLElement = document.documentElement
) {
  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (MODIFIERS.has(event.key)) return;
    root.setAttribute(KEYS_ATTRIBUTE, "");
  };
  const onPointer = () => root.removeAttribute(KEYS_ATTRIBUTE);
  window.addEventListener("keydown", onKey, { capture: true });
  window.addEventListener("pointerdown", onPointer, { capture: true });
  return () => {
    window.removeEventListener("keydown", onKey, { capture: true });
    window.removeEventListener("pointerdown", onPointer, { capture: true });
    root.removeAttribute(KEYS_ATTRIBUTE);
  };
}

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[tabindex]",
].join(",");

function tabbables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.closest("[hidden], [inert], [aria-hidden='true']") &&
      (el.checkVisibility?.({ visibilityProperty: true }) ?? true)
  );
}

const isTab = (event: KeyboardEvent) =>
  event.key === "Tab" ||
  event.code === "Tab" ||
  (event.key === "Unidentified" && event.shiftKey && event.keyCode === 9);

/**
 * Tab past the last stop, or Shift+Tab past the first, wraps inside the
 * window. A webview has no address bar to hand the focus to, so WebKitGTK
 * gave it to nothing: one press with no ring anywhere between the sidebar's
 * cluster name and the status bar.
 *
 * Shift+Tab also steps back from a stop the pointer pressed inside. WebKitGTK
 * searches backward from the pressed label rather than from the focused row,
 * finds the row itself before its own label, and so never moved.
 */
export function startFocusWrap(root: Document = document) {
  let pressed: Node | null = null;
  const onPointer = (event: PointerEvent) => {
    pressed = event.target instanceof Node ? event.target : null;
  };
  const onKey = (event: KeyboardEvent) => {
    if (!isTab(event)) return;
    const from = pressed;
    pressed = null;
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const stops = tabbables(root);
    if (stops.length === 0) return;
    const active = root.activeElement;
    const nowhere = !active || active === root.body;
    const at = active ? stops.indexOf(active as HTMLElement) : -1;
    const last = stops.length - 1;
    const next = event.shiftKey
      ? nowhere || at === 0
        ? stops[last]
        : at > 0 && from && active?.contains(from)
          ? stops[at - 1]
          : null
      : nowhere || at === last
        ? stops[0]
        : null;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  window.addEventListener("pointerdown", onPointer, { capture: true });
  window.addEventListener("keydown", onKey);
  return () => {
    window.removeEventListener("pointerdown", onPointer, { capture: true });
    window.removeEventListener("keydown", onKey);
  };
}
