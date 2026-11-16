const TYPES_TEXT = "input, textarea, select, [contenteditable], [role=textbox]";
const OWN_SELECT_ALL = `[data-select-all], .cm-editor, ${TYPES_TEXT}`;

const within = (node: Node | null) =>
  (node instanceof Element ? node : node?.parentElement)?.closest(
    OWN_SELECT_ALL
  ) != null;

/**
 * The window is a tool, not a document: select-all outside a field would
 * paint every label and cell of whichever page is open. A field, the editor
 * and a region marked `data-select-all` keep their own.
 */
export function keepSelectAllToFields(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      !(event.ctrlKey || event.metaKey) ||
      event.shiftKey ||
      event.altKey ||
      event.key.toLowerCase() !== "a" ||
      within(event.target as Node | null) ||
      within(document.activeElement) ||
      within(window.getSelection()?.anchorNode ?? null)
    )
      return;
    event.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}
