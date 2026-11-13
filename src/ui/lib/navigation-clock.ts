const OPENED_BY_NAVIGATION_MS = 10_000;

let startedAt = 0;

export function markNavigation(at = Date.now()) {
  startedAt = at;
}

export function trackNavigation(router: {
  subscribe: (type: "onBeforeLoad", listener: () => void) => unknown;
}) {
  router.subscribe("onBeforeLoad", () => markNavigation());
}

/**
 * When a surface that has just mounted was opened: the navigation that
 * brought it where one did, since its route's loader began reading then and
 * the page itself mounts after its chunk lands, and its own mount otherwise.
 */
export function openedAt(mountedAt = Date.now()) {
  return mountedAt - startedAt < OPENED_BY_NAVIGATION_MS
    ? startedAt
    : mountedAt;
}
