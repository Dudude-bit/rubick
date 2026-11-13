/** Marks a scroll port that belongs to the page drawn in it, not to the shell. */
export const PAGE_SCROLLER = "data-page-scroller";

// ponytail: a selector resolves to one element, so a page with more ports
// than this keeps the router's copy on the rest.
const MOST_PORTS = 32;

/**
 * The router restores a scroll box by its DOM path, and on a new address
 * copies the old page's offset to whatever sits at the same path. Two lists
 * share a path, so a page's own ports are named here: a new address opens
 * them at the top, and going back still restores them.
 */
let pathChanged = true;

/** Tells the shell's scroller whether the navigation in flight left its page. */
export function followPathChange(router: {
  subscribe: (
    type: "onBeforeLoad",
    listener: (event: { pathChanged: boolean }) => void
  ) => unknown;
}) {
  router.subscribe("onBeforeLoad", (event) => {
    pathChanged = event.pathChanged;
  });
}

/**
 * The shell's own scroller is one box under every page: a new page opens at
 * its top, while a search-param change on the same page keeps the place.
 */
const shellScroller = () =>
  pathChanged ? document.getElementById("main-content") : null;

export const pageScroll = {
  scrollRestoration: true,
  scrollToTopSelectors: [
    shellScroller,
    ...Array.from(
      { length: MOST_PORTS },
      (_, index) => () =>
        document.querySelectorAll(`[${PAGE_SCROLLER}]`).item(index)
    ),
  ],
};
