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
 * height: the row or section under the pointer, or at the top of the
 * scroller when the pointer is elsewhere, holds its place and the scroller
 * makes up whatever moved it. WebKit has no scroll anchoring of its own, so a
 * Needs attention row that came or went moved the Workloads card 15 to 135 px
 * under the pointer.
 */
export function holdScroll(root: HTMLElement): () => void {
  const port = portOf(root);
  if (!port || typeof ResizeObserver === "undefined") return () => {};
  let pointer: number | null = null;
  let anchor: { element: Element; top: number } | null = null;

  const topOf = (element: Element) =>
    element.getBoundingClientRect().top - port.getBoundingClientRect().top;

  // The deepest row or section that reaches below the line the eye is on.
  const pick = () => {
    const line = pointer ?? port.getBoundingClientRect().top;
    let found: Element | null = null;
    for (const element of root.querySelectorAll(
      `:scope > *, [${ANCHOR_ROWS}] > *`
    )) {
      if (element.getBoundingClientRect().bottom <= line) continue;
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
  };
}
