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

const EDITABLE =
  'input, textarea, [contenteditable]:not([contenteditable="false"]), .cm-editor, .xterm';

export function wantsNativeMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(EDITABLE)) return true;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return false;
  return selection.getRangeAt(0).intersectsNode(target);
}
