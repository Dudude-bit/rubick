/** The marker on a container whose children are anchors too, not only the page's sections. */
export const ANCHOR_ROWS = "data-scroll-anchor";

function portOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * Keeps what the reader looks at in place while the page around it changes
 * height: the row or section under the pointer, or with the pointer
 * elsewhere the first section that starts on screen, holds its place and the
 * scroller makes up whatever moved it. A Needs attention row that came or
 * went moved the Workloads card 15 to 135 px under the pointer.
 *
 * At the top of the page nothing is held: a Not checked row arriving there
 * scrolled the title and its "partly unread" off screen. A row is held only
 * under the pointer, where the list itself waits; one held otherwise was
 * followed wherever a reorder took it. The browser's own anchoring is off
 * while this runs, or the two would each make up the same move.
 */
export function holdScroll(root: HTMLElement): () => void {
  const port = portOf(root);
  if (!port || typeof ResizeObserver === "undefined") return () => {};
  let pointer: number | null = null;
  let anchor: { element: Element; top: number } | null = null;

  const topOf = (element: Element) =>
    element.getBoundingClientRect().top - port.getBoundingClientRect().top;

  const pick = () => {
    if (port.scrollTop <= 0) {
      anchor = null;
      return;
    }
    const top = port.getBoundingClientRect().top;
    if (pointer === null) {
      const sections = [...root.children];
      const held =
        sections.find(
          (element) => element.getBoundingClientRect().top >= top
        ) ??
        sections.find(
          (element) => element.getBoundingClientRect().bottom > top
        );
      anchor = held ? { element: held, top: topOf(held) } : null;
      return;
    }
    // The deepest row or section that reaches below the pointer.
    let found: Element | null = null;
    for (const element of root.querySelectorAll(
      `:scope > *, [${ANCHOR_ROWS}] > *`
    )) {
      if (element.getBoundingClientRect().bottom <= pointer) continue;
      if (found && !found.contains(element)) break;
      found = element;
    }
    anchor = found ? { element: found, top: topOf(found) } : null;
  };

  const hold = () => {
    if (anchor?.element.isConnected) {
      const moved = topOf(anchor.element) - anchor.top;
      if (Math.abs(moved) >= 1) port.scrollTop += moved;
    }
    pick();
  };

  // Once a frame: a pointer reports far more often than the page is drawn.
  let frame = 0;
  const point = (event: PointerEvent) => {
    pointer = event.clientY;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      pick();
    });
  };
  const leave = () => {
    pointer = null;
    pick();
  };

  const native = port.style.overflowAnchor;
  port.style.overflowAnchor = "none";
  pick();
  port.addEventListener("scroll", pick, { passive: true });
  port.addEventListener("pointermove", point, { passive: true });
  port.addEventListener("pointerleave", leave);
  const observer = new ResizeObserver(hold);
  observer.observe(root);
  return () => {
    port.removeEventListener("scroll", pick);
    port.removeEventListener("pointermove", point);
    port.removeEventListener("pointerleave", leave);
    cancelAnimationFrame(frame);
    observer.disconnect();
    port.style.overflowAnchor = native;
  };
}
