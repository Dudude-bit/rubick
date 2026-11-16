import * as React from "react";

const CONTROLS =
  "input, textarea, select, [contenteditable], [role=textbox], button, a, [role=button], [role=menuitem]";

/** A selection that survives a click on empty canvas leaves its boxes behind on the table's cells. */
export function useTableSelection(
  containerRef: React.RefObject<HTMLElement | null>
) {
  React.useEffect(() => {
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
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [containerRef]);
}
