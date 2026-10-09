/**
 * WebKit reads the title under a parked pointer again after a click and shows
 * it over whatever opened there, so a peek slid in over the cell shows the
 * covered cell's tooltip until the mouse moves. Held back, the pointer's own
 * way up to `top` has no title until it really moves.
 */
export function holdTitles(
  from: Element,
  top: Element,
  at: { clientX: number; clientY: number }
) {
  const held: [Element, string][] = [];
  for (let el: Element | null = from; el; el = el.parentElement) {
    const title = el.getAttribute("title");
    if (title !== null) {
      held.push([el, title]);
      el.removeAttribute("title");
    }
    if (el === top) break;
  }
  if (held.length === 0) return;
  const release = (event: PointerEvent) => {
    if (event.clientX === at.clientX && event.clientY === at.clientY) return;
    document.removeEventListener("pointermove", release);
    for (const [el, title] of held)
      if (!el.hasAttribute("title")) el.setAttribute("title", title);
  };
  document.addEventListener("pointermove", release);
}
