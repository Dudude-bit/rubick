import * as React from "react";

const TYPES_TEXT = "input, textarea, select, [contenteditable], [role=textbox]";
const CONTROLS = `${TYPES_TEXT}, button, a, [role=button], [role=menuitem]`;

const typesText = (target: EventTarget | null) =>
  target instanceof Element && target.closest(TYPES_TEXT) !== null;

/**
 * A table is a list of objects, not a document: select-all outside a field
 * would paint every label and cell of the page, and a selection that survives
 * a click on empty canvas leaves its boxes behind on the cells.
 */
export function useTableSelection(
  containerRef: React.RefObject<HTMLElement | null>
) {
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "a" &&
        !typesText(event.target) &&
        !typesText(document.activeElement)
      )
        event.preventDefault();
    };
    const onPointerDown = (event: PointerEvent) => {
      const selection = window.getSelection();
      const container = containerRef.current;
      if (
        !selection ||
        selection.isCollapsed ||
        !container ||
        !(
          container.contains(selection.anchorNode) ||
          container.contains(selection.focusNode) ||
          selection.containsNode(container, true)
        ) ||
        (event.target instanceof Element &&
          event.target.closest(CONTROLS) !== null)
      )
        return;
      selection.removeAllRanges();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [containerRef]);
}
