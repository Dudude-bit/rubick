/**
 * Scroll `element` into view inside the nearest box that scrolls, and only
 * that box. `scrollIntoView` and a plain `focus()` move every scrollable
 * ancestor, the document included, which shifted the whole window under a
 * reader walking a list with the arrows.
 *
 * `cover` is how much of the top of that box something sticky hides, a
 * table's own header, so a row is not "revealed" underneath it.
 */
export function revealInScroller(element: HTMLElement, cover = 0): void {
  const port = scrollerOf(element);
  if (!port) return;
  const portBox = port.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const top = portBox.top + cover;
  if (box.top < top) port.scrollTop -= top - box.top;
  else if (box.bottom > portBox.bottom)
    port.scrollTop += box.bottom - portBox.bottom;
}

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (
    let node = element.parentElement;
    node && node !== document.body && node !== document.documentElement;
    node = node.parentElement
  ) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return null;
}
