/**
 * jsdom lays nothing out, so a virtual list measures its scroller as zero
 * tall and draws no row at all. This gives every box a height: a list item
 * one row, anything else a screen. Returns how to take it off again.
 */
export function layOutVirtualLists(viewportPx = 600, rowPx = 26): () => void {
  const proto = HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  Object.defineProperty(proto, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === "LI" ? rowPx : viewportPx;
    },
  });
  return () => {
    if (original) Object.defineProperty(proto, "offsetHeight", original);
  };
}
