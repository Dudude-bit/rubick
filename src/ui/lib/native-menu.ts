/**
 * The webview's own right-click menu offers Back, Reload and Inspect Element,
 * none of which belong in an app window. It stays where copy and paste live:
 * a text field, the code editor, the terminal, and text the reader selected.
 */
export function keepNativeMenuForText(): () => void {
  const onMenu = (event: MouseEvent) => {
    if (wantsNativeMenu(event.target)) return;
    event.preventDefault();
  };
  // Bubbling, after the app's own handlers: a Radix menu trigger ignores an
  // event already prevented, so a capturing listener left every one shut.
  window.addEventListener("contextmenu", onMenu);
  return () => window.removeEventListener("contextmenu", onMenu);
}

export const isMenuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);

/** Opens `element`'s own menu under it, where a keyboard has no pointer to open it at. */
export function openMenuOn(element: Element): void {
  const box = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: box.left,
      clientY: box.bottom,
    })
  );
}

/**
 * The Menu key and Shift+F10 open the focused control's menu, under it. Left
 * to the webview, the event went to whatever lay under the control's corner,
 * so the new tab button never opened its menu. A key a control already
 * answered, and a field's own menu, are left alone.
 */
export function openMenusFromKeys(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isMenuKey(event)) return;
    const focused = document.activeElement;
    if (wantsNativeMenu(focused)) return;
    event.preventDefault();
    if (focused && focused !== document.body) openMenuOn(focused);
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}

const EDITABLE =
  'input, textarea, [contenteditable]:not([contenteditable="false"]), .cm-editor, .xterm';

export function wantsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(EDITABLE)) return true;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return selection.getRangeAt(0).intersectsNode(target);
}
