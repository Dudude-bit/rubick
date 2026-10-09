/**
 * Whether the surface a query belongs to is the one on screen.
 *
 * "Mounted" stopped being a proxy for "visible" the day a detail tab holding a
 * shell or a log stream had to survive being switched away from: Radix
 * force-mounts a surface panel once it has been opened, so a Logs tab nobody
 * is looking at renders — and, until this existed, polled — for as long as the
 * page is open. The Overview tab has the same problem from the other end,
 * since the page's blocks moved *into* it.
 *
 * So the answer is passed down rather than guessed. A container that knows one
 * of its children is off screen provides `false` for that child's subtree, and
 * every `useLiveQuery` under it stops. Nesting is an `&&`: something inside a
 * hidden tab is hidden however visible its own parent thinks it is.
 *
 * The default is `true`, and it has to be: a query with nothing above it
 * claiming otherwise is on screen, and a mechanism that defaulted to "hidden"
 * would silently stop screens nobody remembered to wire up.
 *
 * @module lib/surface-visibility
 */

import { createContext, useContext } from "react";

export const SurfaceVisibility = createContext(true);

/** Is the surface holding this component the one the reader can see? */
export function useSurfaceVisible(): boolean {
  return useContext(SurfaceVisibility);
}
