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
